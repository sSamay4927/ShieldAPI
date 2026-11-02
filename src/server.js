const app = require('./app');
const { config } = require('./config/env');
const { connect: connectMongo, disconnect: disconnectMongo } = require('./infrastructure/mongo/mongoClient');
const { connect: connectRedis, disconnect: disconnectRedis } = require('./infrastructure/redis/redisClient');
const { startMockUpstream } = require('./upstream/mockUpstream');
const { startWorker } = require('./workers/auditWorker');

let mockServer = null;
let auditShutdown = null;

// Initiate background infrastructure connections (non-blocking)
connectMongo().catch(() => {});
connectRedis().catch(() => {});

// If UPSTREAM_BASE_URL targets local loopback, start mock upstream automatically (ideal for single-instance cloud deploys like Render)
if (
  process.env.START_INTERNAL_SERVICES !== 'false' &&
  (config.UPSTREAM_BASE_URL.includes('localhost') || config.UPSTREAM_BASE_URL.includes('127.0.0.1'))
) {
  try {
    const parsed = new URL(config.UPSTREAM_BASE_URL);
    const mockPort = Number(parsed.port) || 4001;
    startMockUpstream(mockPort)
      .then(({ server }) => {
        mockServer = server;
      })
      .catch((err) => {
        console.warn('[ShieldAPI] In-process mock upstream already running or unavailable:', err.message);
      });
  } catch {}
}

// Start in-process audit worker for single-instance deploys
if (process.env.START_INTERNAL_WORKER !== 'false') {
  startWorker()
    .then(({ shutdown }) => {
      auditShutdown = shutdown;
    })
    .catch((err) => {
      console.warn('[ShieldAPI] Could not start in-process audit worker:', err.message);
    });
}

const server = app.listen(config.PORT, () => {
  console.log(`[ShieldAPI] Server running on port ${config.PORT} (PID: ${process.pid}, ENV: ${config.NODE_ENV})`);
});

// Process signals for graceful termination
async function gracefulShutdown(signal) {
  console.log(`[ShieldAPI] ${signal} received, shutting down gracefully...`);
  if (auditShutdown) {
    await auditShutdown().catch(() => {});
  }
  if (mockServer) {
    await new Promise((r) => mockServer.close(r)).catch(() => {});
  }
  server.close(async () => {
    await disconnectMongo();
    await disconnectRedis();
    console.log('[ShieldAPI] Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = server;
