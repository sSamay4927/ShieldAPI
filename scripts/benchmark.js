/**
 * ShieldAPI - Comprehensive Benchmark & MongoDB ExecutionStats Script
 * 
 * Measures:
 * 1. HTTP Throughput & Latency Distribution (Baseline vs Gateway Allowed vs Gateway Denied 429)
 * 2. MongoDB Query Explain Plan & Index Utilization (IXSCAN vs COLLSCAN)
 * 
 * Usage:
 *   node scripts/benchmark.js
 */

const http = require('http');
const os = require('os');
const crypto = require('crypto');
const mongoose = require('mongoose');
const IORedis = require('ioredis');

const { config } = require('../src/config/env');
const express = require('express');
const helmet = require('helmet');
const requestIdMiddleware = require('../src/middleware/requestId');
const errorHandler = require('../src/middleware/errorHandler');
const healthRoutes = require('../src/routes/health.routes');
const { identifyClient } = require('../src/middleware/identifyClient');
const { createRateLimitMiddleware } = require('../src/middleware/rateLimit');
const { createUpstreamProxy } = require('../src/proxy/upstreamProxy');
const { createMockUpstreamApp } = require('../src/upstream/mockUpstream');
const AuditLog = require('../src/infrastructure/mongo/AuditLog.model');
const { getQueue } = require('../src/infrastructure/queue/auditQueue');
const redisClient = require('../src/infrastructure/redis/redisClient');
const mongoClient = require('../src/infrastructure/mongo/mongoClient');

function createBenchmarkGateway(upstreamUrl, policyOptions = {}) {
  const app = express();
  app.use(helmet());
  app.use(requestIdMiddleware);
  app.use(express.json({ limit: '100kb' }));
  app.use('/health', healthRoutes);
  app.use(
    '/gateway/v1',
    identifyClient,
    createRateLimitMiddleware({
      policy: {
        id: 'benchmark-policy',
        windowMs: policyOptions.windowMs || 60000,
        maxRequests: policyOptions.maxRequests || 10,
        failMode: policyOptions.failMode || 'closed'
      }
    }),
    createUpstreamProxy({ target: upstreamUrl })
  );
  app.use(errorHandler);
  return app;
}

// Helper to calculate percentiles from a sorted array of numbers
function calculatePercentiles(sortedValues) {
  if (!sortedValues.length) {
    return { min: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }
  const min = sortedValues[0];
  const max = sortedValues[sortedValues.length - 1];
  const sum = sortedValues.reduce((acc, val) => acc + val, 0);
  const mean = sum / sortedValues.length;

  const p50 = sortedValues[Math.floor(sortedValues.length * 0.50)];
  const p90 = sortedValues[Math.floor(sortedValues.length * 0.90)];
  const p95 = sortedValues[Math.floor(sortedValues.length * 0.95)];
  const p99 = sortedValues[Math.floor(sortedValues.length * 0.99)];

  return {
    min: Number(min.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    p50: Number(p50.toFixed(2)),
    p90: Number(p90.toFixed(2)),
    p95: Number(p95.toFixed(2)),
    p99: Number(p99.toFixed(2)),
    max: Number(max.toFixed(2))
  };
}

// Low-overhead HTTP request runner using keepAlive agent
function makeRequest(agent, url, headers) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      agent,
      headers: {
        'connection': 'keep-alive',
        ...headers
      }
    };

    const startTime = process.hrtime.bigint();
    const req = http.request(options, (res) => {
      // Drain data
      res.on('data', () => {});
      res.on('end', () => {
        const endTime = process.hrtime.bigint();
        const durationMs = Number(endTime - startTime) / 1e6;
        resolve({ statusCode: res.statusCode, durationMs });
      });
    });

    req.on('error', (err) => {
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1e6;
      resolve({ statusCode: 0, error: err.message, durationMs });
    });

    req.end();
  });
}

// Concurrent request executor pool
async function runConcurrentBenchmark({ name, url, totalRequests, concurrency, getHeaders }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const durations = [];
  const statusCounts = {};

  let completed = 0;
  let requestIndex = 0;

  const benchmarkStart = process.hrtime.bigint();

  async function worker() {
    while (requestIndex < totalRequests) {
      const i = requestIndex++;
      const headers = getHeaders ? getHeaders(i) : {};
      const res = await makeRequest(agent, url, headers);
      durations.push(res.durationMs);
      statusCounts[res.statusCode] = (statusCounts[res.statusCode] || 0) + 1;
      completed++;
    }
  }

  // Launch concurrency workers
  const workers = [];
  for (let c = 0; c < concurrency; c++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const benchmarkEnd = process.hrtime.bigint();
  const totalDurationSec = Number(benchmarkEnd - benchmarkStart) / 1e9;
  agent.destroy();

  durations.sort((a, b) => a - b);
  const percentiles = calculatePercentiles(durations);
  const throughput = Number((totalRequests / totalDurationSec).toFixed(1));

  return {
    name,
    totalRequests,
    concurrency,
    totalDurationSec: Number(totalDurationSec.toFixed(2)),
    throughputReqSec: throughput,
    statusCounts,
    percentiles
  };
}

async function runBenchmark() {
  console.log('='.repeat(70));
  console.log(' ShieldAPI — Performance Benchmark & Query Inspection Suite');
  console.log('='.repeat(70));

  // 1. Hardware & Environment Information
  const cpus = os.cpus();
  const envInfo = {
    osPlatform: `${os.platform()} (${os.release()})`,
    cpuModel: cpus[0].model,
    cpuCores: cpus.length,
    totalMemoryGB: (os.totalmem() / 1e9).toFixed(2),
    nodeVersion: process.version
  };

  console.log('\n[1/3] Detecting Environment...');
  console.log(`  OS:          ${envInfo.osPlatform}`);
  console.log(`  CPU:         ${envInfo.cpuModel} (${envInfo.cpuCores} cores)`);
  console.log(`  Memory:      ${envInfo.totalMemoryGB} GB`);
  console.log(`  Node.js:     ${envInfo.nodeVersion}`);

  // Query Redis version
  const rawRedis = new IORedis(config.REDIS_URL, { lazyConnect: true });
  await rawRedis.connect();
  const redisInfo = await rawRedis.info('server');
  const redisVersion = (redisInfo.split('\r\n').find((l) => l.startsWith('redis_version:')) || 'redis_version:unknown').split(':')[1];
  console.log(`  Redis:       v${redisVersion}`);

  // Query Mongo version
  await mongoClient.connect();
  const admin = new mongoose.mongo.Admin(mongoose.connection.db);
  const mongoBuildInfo = await admin.buildInfo();
  const mongoVersion = mongoBuildInfo.version;
  console.log(`  MongoDB:     v${mongoVersion}`);

  // 2. Start Servers for HTTP Benchmarking
  console.log('\n[2/3] Launching In-Process Benchmark Gateway & Mock Upstream...');
  const mockUpstream = createMockUpstreamApp();
  const upstreamServer = await new Promise((resolve) => {
    const s = mockUpstream.listen(0, '127.0.0.1', () => resolve(s));
  });
  const upstreamPort = upstreamServer.address().port;
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

  await redisClient.connect();

  const gatewayApp = createBenchmarkGateway(upstreamUrl);
  const gatewayServer = await new Promise((resolve) => {
    const s = gatewayApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const gatewayPort = gatewayServer.address().port;
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;

  console.log(`  Mock Upstream bound on:  ${upstreamUrl}`);
  console.log(`  Gateway Server bound on: ${gatewayBaseUrl}`);

  const TOTAL_REQUESTS = 500;
  const CONCURRENCY = 10;

  console.log(`\n  Executing ${TOTAL_REQUESTS} requests per scenario (concurrency = ${CONCURRENCY})...\n`);

  // Scenario 1: Baseline Route (GET /health/live)
  console.log('  Running Scenario 1: Baseline Route (GET /health/live)...');
  const baselineResult = await runConcurrentBenchmark({
    name: 'Baseline Route (GET /health/live)',
    url: `${gatewayBaseUrl}/health/live`,
    totalRequests: TOTAL_REQUESTS,
    concurrency: CONCURRENCY
  });

  // Scenario 2: Gateway Allowed (GET /gateway/v1/catalog with rotating client keys)
  console.log('  Running Scenario 2: Gateway Allowed (GET /gateway/v1/catalog, unexhausted quota)...');
  const allowedResult = await runConcurrentBenchmark({
    name: 'Gateway Allowed (GET /gateway/v1/catalog)',
    url: `${gatewayBaseUrl}/gateway/v1/catalog`,
    totalRequests: TOTAL_REQUESTS,
    concurrency: CONCURRENCY,
    getHeaders: (index) => ({
      // Rotate keys across 200 clients so quota is never exceeded
      'x-api-key': `client-bench-${index % 200}`
    })
  });

  // Scenario 3: Gateway Denied (GET /gateway/v1/catalog with a single key exceeding quota)
  console.log('  Running Scenario 3: Gateway Rate-Limited (GET /gateway/v1/catalog, exhausted quota -> 429)...');
  const singleKey = `bench-exhausted-${Date.now()}`;
  const deniedResult = await runConcurrentBenchmark({
    name: 'Gateway Rate-Limited 429 (GET /gateway/v1/catalog)',
    url: `${gatewayBaseUrl}/gateway/v1/catalog`,
    totalRequests: TOTAL_REQUESTS,
    concurrency: CONCURRENCY,
    getHeaders: () => ({
      'x-api-key': singleKey
    })
  });

  // 3. MongoDB Query ExecutionStats Analysis
  console.log('\n[3/3] Inspecting MongoDB Query Plans via explain("executionStats")...');
  await AuditLog.init(); // Ensure indexes are compiled

  const SEED_COUNT = 2000;
  console.log(`  Seeding ${SEED_COUNT} benchmark audit documents...`);
  const benchmarkPrefix = `bench_${Date.now()}`;
  const sampleDigests = [
    crypto.createHash('sha256').update(`${benchmarkPrefix}_client_target`).digest('hex'),
    crypto.createHash('sha256').update(`${benchmarkPrefix}_client_other_1`).digest('hex'),
    crypto.createHash('sha256').update(`${benchmarkPrefix}_client_other_2`).digest('hex')
  ];

  const targetDigest = sampleDigests[0];
  const docs = [];
  const now = Date.now();

  for (let i = 0; i < SEED_COUNT; i++) {
    // 10% target client, 90% other clients
    const digest = i % 10 === 0 ? targetDigest : sampleDigests[1 + (i % 2)];
    // Distributed across the last 48 hours
    const ageMs = (i / SEED_COUNT) * 48 * 60 * 60 * 1000;
    docs.push({
      eventId: `${benchmarkPrefix}_evt_${i}`,
      occurredAt: new Date(now - ageMs),
      route: '/gateway/v1/catalog',
      method: 'GET',
      policyId: 'default',
      identityType: 'api-key',
      identityDigest: digest,
      decision: 'RATE_LIMITED',
      requestId: crypto.randomUUID(),
      limit: 10,
      windowMs: 60000,
      retryAfterMs: 45000,
      expireAt: new Date(now + 86400000)
    });
  }
  await AuditLog.insertMany(docs);

  // Query 1: Compound index lookup (identityDigest + occurredAt)
  const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
  console.log('  Executing Query 1 (Compound index: identityDigest + occurredAt >= 24h)...');
  const explainCompound = await AuditLog.find({
    identityDigest: targetDigest,
    occurredAt: { $gte: twentyFourHoursAgo }
  }).explain('executionStats');

  // Extract winning stage and index name
  function extractPlanInfo(explainResult) {
    const stats = explainResult.executionStats;
    let winningStage = stats.executionStages.stage;
    let indexUsed = 'None';
    
    // Drill down to locate IXSCAN
    function findIxScan(stage) {
      if (!stage) return null;
      if (stage.stage === 'IXSCAN') return stage.indexName;
      if (stage.inputStage) return findIxScan(stage.inputStage);
      if (stage.inputStages) {
        for (const sub of stage.inputStages) {
          const res = findIxScan(sub);
          if (res) return res;
        }
      }
      return null;
    }

    const ix = findIxScan(stats.executionStages);
    if (ix) indexUsed = ix;

    return {
      stage: winningStage,
      indexUsed,
      nReturned: stats.nReturned,
      totalKeysExamined: stats.totalKeysExamined,
      totalDocsExamined: stats.totalDocsExamined,
      executionTimeMillis: stats.executionTimeMillis
    };
  }

  const compoundStats = extractPlanInfo(explainCompound);

  // Query 2: Time-range scan across all clients using single-field index (occurredAt)
  console.log('  Executing Query 2 (Single-field index: occurredAt >= 24h)...');
  const explainTimeRange = await AuditLog.find({
    occurredAt: { $gte: twentyFourHoursAgo }
  }).explain('executionStats');
  const timeRangeStats = extractPlanInfo(explainTimeRange);

  // Query 3: Unindexed / Collscan query
  console.log('  Executing Query 3 (Forced collection scan: unindexed field match)...');
  const explainCollscan = await AuditLog.find({
    identityDigest: targetDigest,
    occurredAt: { $gte: twentyFourHoursAgo }
  }).hint({ $natural: 1 }).explain('executionStats');
  const collscanStats = extractPlanInfo(explainCollscan);

  // Clean up benchmark seed data
  console.log('  Cleaning up seeded benchmark documents...');
  await AuditLog.deleteMany({ eventId: new RegExp(`^${benchmarkPrefix}`) });

  // Teardown HTTP servers
  await new Promise((resolve) => gatewayServer.close(resolve));
  await new Promise((resolve) => upstreamServer.close(resolve));
  const queue = getQueue();
  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close().catch(() => {});
  await rawRedis.disconnect();
  await redisClient.disconnect();
  await mongoClient.disconnect();

  // Print Summary Results
  console.log('\n' + '='.repeat(70));
  console.log(' BENCHMARK SUMMARY RESULTS');
  console.log('='.repeat(70));

  const httpResults = [baselineResult, allowedResult, deniedResult];
  console.log('\n--- HTTP Latency & Throughput (N=500, Concurrency=10) ---');
  console.table(httpResults.map(r => ({
    Scenario: r.name,
    'Req/Sec': r.throughputReqSec,
    'p50 (ms)': r.percentiles.p50,
    'p90 (ms)': r.percentiles.p90,
    'p95 (ms)': r.percentiles.p95,
    'p99 (ms)': r.percentiles.p99,
    'StatusCodes': JSON.stringify(r.statusCounts)
  })));

  console.log('\n--- MongoDB Query Plan & Index Utilization ---');
  console.table([
    {
      Query: 'Query 1 (Target Client Last 24h)',
      Index: compoundStats.indexUsed,
      Stage: compoundStats.stage,
      Returned: compoundStats.nReturned,
      'Keys Examined': compoundStats.totalKeysExamined,
      'Docs Examined': compoundStats.totalDocsExamined,
      'Time (ms)': compoundStats.executionTimeMillis
    },
    {
      Query: 'Query 2 (All Violations Last 24h)',
      Index: timeRangeStats.indexUsed,
      Stage: timeRangeStats.stage,
      Returned: timeRangeStats.nReturned,
      'Keys Examined': timeRangeStats.totalKeysExamined,
      'Docs Examined': timeRangeStats.totalDocsExamined,
      'Time (ms)': timeRangeStats.executionTimeMillis
    },
    {
      Query: 'Query 3 (Unindexed COLLSCAN baseline)',
      Index: 'COLLSCAN',
      Stage: collscanStats.stage,
      Returned: collscanStats.nReturned,
      'Keys Examined': collscanStats.totalKeysExamined,
      'Docs Examined': collscanStats.totalDocsExamined,
      'Time (ms)': collscanStats.executionTimeMillis
    }
  ]);

  return {
    envInfo: { ...envInfo, redisVersion, mongoVersion },
    httpResults,
    mongoResults: {
      compoundStats,
      timeRangeStats,
      collscanStats
    }
  };
}

if (require.main === module) {
  runBenchmark()
    .then(() => {
      console.log('\nBenchmark execution completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\nBenchmark failed with error:', err);
      process.exit(1);
    });
}

module.exports = { runBenchmark };
