const Redis = require('ioredis');
const { config } = require('../../config/env');
const { logger } = require('../../utils/logger');

let clientInstance = null;

/**
 * Get or create the shared ioredis client instance.
 */
function getClient(url = config.REDIS_URL) {
  if (clientInstance) {
    return clientInstance;
  }

  clientInstance = new Redis(url, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    enableReadyCheck: true,
    retryStrategy(times) {
      if (times > 10) {
        return null; // Stop after 10 retries
      }
      return Math.min(times * 150, 1500); // Backoff up to 1.5 seconds
    }
  });

  clientInstance.on('ready', () => {
    logger.info('Connected to Redis server and ready for commands', {
      status: clientInstance ? clientInstance.status : 'unknown'
    });
  });

  clientInstance.on('error', (err) => {
    logger.warn('Redis client error encountered', {
      error: err.message,
      status: clientInstance ? clientInstance.status : 'uninitialized'
    });
  });

  clientInstance.on('close', () => {
    logger.warn('Redis connection closed');
  });

  clientInstance.on('reconnecting', (time) => {
    logger.info(`Redis reconnecting in ${time} ms...`);
  });

  return clientInstance;
}

/**
 * Explicitly connect / ensure Redis server is ready.
 */
async function connect(url = config.REDIS_URL) {
  const client = getClient(url);
  if (client.status === 'ready') {
    return client;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (client.status === 'ready') {
        resolve(client);
      } else {
        reject(new Error(`Redis connection timeout after 6000ms (current status: ${client.status})`));
      }
    }, 6000);

    client.once('ready', () => {
      clearTimeout(timer);
      resolve(client);
    });

    client.once('error', (err) => {
      if (client.status === 'ready') {
        clearTimeout(timer);
        resolve(client);
      }
    });
  });
}

/**
 * Disconnect cleanly from Redis.
 */
async function disconnect() {
  if (clientInstance) {
    const clientToClose = clientInstance;
    clientInstance = null;
    try {
      if (clientToClose.status !== 'end') {
        await clientToClose.quit();
      }
    } catch {
      clientToClose.disconnect();
    }
    logger.info('Disconnected from Redis');
  }
}

/**
 * Execute PING to test Redis reachability.
 */
async function ping() {
  const client = getClient();
  if (client.status !== 'ready') {
    await connect();
  }
  return client.ping();
}

/**
 * Check if Redis is connected and in ready state.
 */
function isConnected() {
  return clientInstance !== null && clientInstance.status === 'ready';
}

/**
 * Return current status string.
 */
function getStatus() {
  return clientInstance ? clientInstance.status : 'disconnected';
}

module.exports = {
  getClient,
  connect,
  disconnect,
  ping,
  isConnected,
  getStatus
};
