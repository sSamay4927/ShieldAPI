const os = require('os');
const mongoose = require('mongoose');
const { config } = require('../../config/env');
const { logger } = require('../../utils/logger');

let isConnecting = false;

const readyStateMap = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting'
};

/**
 * Connect to MongoDB instance.
 * Resilient to failure: logs errors and warnings rather than crashing process,
 * keeping the gateway process alive even if the database is offline.
 */
async function connect(uri = config.MONGODB_URI) {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (isConnecting) {
    return mongoose.connection;
  }

  isConnecting = true;
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000, // Fast fail if server unavailable
      driverInfo: { name: 'nodejs', version: process.version || '22.12.0' },
      runtimeAdapters: { os } // Avoids dynamic import('os') in test environments/sandboxes
    });
    logger.info('Connected to MongoDB database', {
      uri: uri.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@') // Mask credentials if present
    });
  } catch (err) {
    logger.warn('Failed to establish MongoDB connection; audit persistence degraded', {
      error: err.message
    });
  } finally {
    isConnecting = false;
  }

  return mongoose.connection;
}

/**
 * Disconnect cleanly from MongoDB.
 */
async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('Disconnected from MongoDB');
  }
}

/**
 * Check if MongoDB connection is active and ready for operations.
 */
function isConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * Return current connection state as human-readable string.
 */
function getStatus() {
  return readyStateMap[mongoose.connection.readyState] || 'unknown';
}

// Global connection event handlers for diagnostics
mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB connection lost; audit pipeline will queue/retry');
});

mongoose.connection.on('error', (err) => {
  logger.error('MongoDB connection error encountered', { error: err.message });
});

module.exports = {
  connect,
  disconnect,
  isConnected,
  getStatus,
  mongoose
};
