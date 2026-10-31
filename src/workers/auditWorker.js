const { Worker } = require('bullmq');
const { QUEUE_NAME, getRedisConnectionOptions } = require('../infrastructure/queue/auditQueue');
const AuditLog = require('../infrastructure/mongo/AuditLog.model');
const { connect: connectMongo, disconnect: disconnectMongo } = require('../infrastructure/mongo/mongoClient');
const { logger } = require('../utils/logger');

/**
 * Validate incoming audit job payload before persisting to MongoDB.
 */
function validateAuditPayload(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Audit job data must be a non-empty object');
  }
  const required = ['eventId', 'route', 'method', 'identityType', 'identityDigest', 'decision', 'requestId'];
  for (const field of required) {
    if (!data[field]) {
      throw new Error(`Invalid audit job payload: missing required field "${field}"`);
    }
  }
}

/**
 * Audit Job Processor
 * Persists validated audit event into MongoDB AuditLog collection.
 */
async function processAuditJob(job) {
  validateAuditPayload(job.data);

  try {
    const doc = await AuditLog.create(job.data);
    logger.info('Audit event persisted successfully', {
      jobId: job.id,
      eventId: job.data.eventId,
      requestId: job.data.requestId,
      decision: job.data.decision
    });
    return { success: true, id: doc._id.toString() };
  } catch (err) {
    // Idempotent duplicate check: if eventId already exists (E11000), consider completed
    if (err.code === 11000) {
      logger.warn('Duplicate audit event ignored (already persisted)', {
        eventId: job.data.eventId
      });
      return { success: true, duplicate: true };
    }

    logger.error('Failed to write audit document to MongoDB; BullMQ will retry', {
      jobId: job.id,
      error: err.message,
      attempt: job.attemptsMade + 1
    });

    throw err; // Trigger BullMQ exponential backoff retry
  }
}

/**
 * Create and configure an Audit Worker instance.
 */
function createAuditWorker(options = {}) {
  const connection = options.connection || getRedisConnectionOptions();

  const worker = new Worker(QUEUE_NAME, processAuditJob, {
    connection,
    concurrency: options.concurrency || 5
  });

  worker.on('completed', (job) => {
    logger.debug(`Audit worker job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Audit worker job ${job ? job.id : 'unknown'} failed`, {
      error: err.message,
      attemptsMade: job ? job.attemptsMade : 0
    });
  });

  worker.on('error', (err) => {
    logger.error('Audit worker internal error', { error: err.message });
  });

  return worker;
}

/**
 * Start the standalone worker with MongoDB connection.
 */
async function startWorker() {
  await connectMongo();
  const worker = createAuditWorker();
  logger.info(`[AuditWorker] BullMQ Worker listening on queue "${QUEUE_NAME}"`);

  const shutdown = async () => {
    logger.info('[AuditWorker] Shutting down audit worker gracefully...');
    await worker.close();
    await disconnectMongo();
    logger.info('[AuditWorker] Shutdown complete');
  };

  return { worker, shutdown };
}

// Standalone execution entry point
if (require.main === module) {
  startWorker().then(({ shutdown }) => {
    process.on('SIGINT', async () => {
      await shutdown();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await shutdown();
      process.exit(0);
    });
  }).catch((err) => {
    console.error('[AuditWorker] Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = {
  createAuditWorker,
  processAuditJob,
  startWorker
};

