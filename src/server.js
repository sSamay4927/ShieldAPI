const app = require('./app');
const { config } = require('./config/env');
const { connect: connectMongo, disconnect: disconnectMongo } = require('./infrastructure/mongo/mongoClient');
const { connect: connectRedis, disconnect: disconnectRedis } = require('./infrastructure/redis/redisClient');

// Initiate background connections (non-blocking)
connectMongo().catch(() => {});
connectRedis().catch(() => {});

const server = app.listen(config.PORT, () => {
  console.log(`[ShieldAPI] Server running on port ${config.PORT} (PID: ${process.pid}, ENV: ${config.NODE_ENV})`);
});

// Process signals for graceful termination
process.on('SIGTERM', () => {
  console.log('[ShieldAPI] SIGTERM received, shutting down gracefully...');
  server.close(async () => {
    await disconnectMongo();
    await disconnectRedis();
    console.log('[ShieldAPI] Shutdown complete');
  });
});

process.on('SIGINT', () => {
  console.log('[ShieldAPI] SIGINT received, shutting down gracefully...');
  server.close(async () => {
    await disconnectMongo();
    await disconnectRedis();
    console.log('[ShieldAPI] Shutdown complete');
    process.exit(0);
  });
});

module.exports = server;
