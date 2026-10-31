const { config } = require('./env');

/**
 * Predefined Rate Limit Policies
 * Centralized policy registry for the gateway routes.
 */
const policies = {
  default: {
    id: 'default',
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    maxRequests: config.RATE_LIMIT_MAX_REQUESTS,
    failMode: config.RATE_LIMIT_FAIL_MODE
  }
};

function getPolicy(policyId = 'default') {
  const policy = policies[policyId];
  if (!policy) {
    throw new Error(`Unknown rate limit policy: "${policyId}"`);
  }
  return policy;
}

module.exports = {
  policies,
  getPolicy
};
