const http = require('http');
const crypto = require('crypto');

/**
 * Concurrency Test Script
 * Sends 50 simultaneous requests with the same API key to prove race-condition freedom
 * and exact quota enforcement via atomic Redis Lua sliding-window script.
 */
async function runConcurrencyTest(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port || 3000;
  const path = options.path || '/gateway/v1/catalog';
  const totalRequests = options.totalRequests || 50;
  const expectedLimit = options.expectedLimit || 10;
  const testKey = options.apiKey || `concurrency-test-${crypto.randomUUID()}`;

  console.log('='.repeat(70));
  console.log('ShieldAPI — 50-Request Concurrency Race-Condition Test');
  console.log('='.repeat(70));
  console.log(`Target:           http://${host}:${port}${path}`);
  console.log(`Total Requests:   ${totalRequests}`);
  console.log(`Expected Limit:   ${expectedLimit}`);
  console.log(`Test API Key:     ${testKey}`);
  console.log('-'.repeat(70));

  const startTime = Date.now();

  function sendSingleRequest(index) {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host,
          port,
          path,
          method: 'GET',
          headers: {
            'X-API-Key': testKey,
            'X-Request-Id': crypto.randomUUID()
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            resolve({
              index,
              statusCode: res.statusCode,
              headers: res.headers,
              body: data
            });
          });
        }
      );

      req.on('error', (err) => {
        resolve({
          index,
          statusCode: 0,
          error: err.message
        });
      });

      req.end();
    });
  }

  // Dispatch all requests concurrently
  const promises = [];
  for (let i = 1; i <= totalRequests; i++) {
    promises.push(sendSingleRequest(i));
  }

  const results = await Promise.all(promises);
  const durationMs = Date.now() - startTime;

  const statusCounts = {};
  for (const r of results) {
    statusCounts[r.statusCode] = (statusCounts[r.statusCode] || 0) + 1;
  }

  const allowedCount = statusCounts[200] || 0;
  const deniedCount = statusCounts[429] || 0;
  const errorCount = totalRequests - allowedCount - deniedCount;

  console.log('Results Summary:');
  console.log(`  Allowed (200 OK):                ${allowedCount}`);
  console.log(`  Rate-Limited (429 Denied):        ${deniedCount}`);
  console.log(`  Other / Network Errors:          ${errorCount}`);
  console.log(`  Total Test Duration:             ${durationMs} ms`);
  console.log(`  Status Breakdown:                ${JSON.stringify(statusCounts)}`);
  console.log('-'.repeat(70));

  const isExact = allowedCount === expectedLimit && deniedCount === (totalRequests - expectedLimit);

  if (isExact) {
    console.log(`[PASS] EXACT QUOTA ENFORCED! Exactly ${allowedCount} allowed, ${deniedCount} denied.`);
    console.log('Zero race conditions observed across concurrent requests.');
  } else {
    console.error(`[FAIL] Race condition or configuration mismatch! Expected ${expectedLimit} allowed, received ${allowedCount}.`);
  }
  console.log('='.repeat(70));

  return {
    allowedCount,
    deniedCount,
    statusCounts,
    durationMs,
    isExact
  };
}

if (require.main === module) {
  const host = process.env.GATEWAY_HOST || '127.0.0.1';
  const port = process.env.GATEWAY_PORT || 3000;
  const expectedLimit = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 10;

  runConcurrencyTest({ host, port, expectedLimit }).then((res) => {
    process.exit(res.isExact ? 0 : 1);
  }).catch((err) => {
    console.error('Fatal concurrency test error:', err);
    process.exit(1);
  });
}

module.exports = {
  runConcurrencyTest
};

