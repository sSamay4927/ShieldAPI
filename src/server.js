const app = require('./app');
const { config } = require('./config/env');

const server = app.listen(config.PORT, () => {
  console.log(`[ShieldAPI] Server running on port ${config.PORT} (PID: ${process.pid}, ENV: ${config.NODE_ENV})`);
});

// Process signals for graceful termination
process.on('SIGTERM', () => {
  console.log('[ShieldAPI] SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('[ShieldAPI] HTTP server closed');
  });
});

process.on('SIGINT', () => {
  console.log('[ShieldAPI] SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('[ShieldAPI] HTTP server closed');
    process.exit(0);
  });
});

module.exports = server;
