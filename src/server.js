const app = require('./app');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`[ShieldAPI] Server running on port ${PORT} (PID: ${process.pid})`);
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
