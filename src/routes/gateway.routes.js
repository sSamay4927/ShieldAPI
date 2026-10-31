const express = require('express');
const { identifyClient } = require('../middleware/identifyClient');
const { rateLimit } = require('../middleware/rateLimit');
const { upstreamProxy } = require('../proxy/upstreamProxy');

const router = express.Router();

/**
 * Gateway v1 Router
 * Pipeline: identifyClient -> rateLimit -> upstreamProxy
 * All /gateway/v1/* traffic is rate-limited before reaching the upstream proxy.
 */
router.use(identifyClient);
router.use(rateLimit);
router.use(upstreamProxy);

module.exports = router;
