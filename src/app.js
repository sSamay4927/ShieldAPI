const express = require('express');
const requestIdMiddleware = require('./middleware/requestId');
const { requestLoggerMiddleware } = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health.routes');
const gatewayRoutes = require('./routes/gateway.routes');
const { NotFoundError } = require('./utils/errors');

const app = express();

// 1. Request ID assignment and propagation (runs on every incoming request)
app.use(requestIdMiddleware);

// 2. Structured request logging (safe, no secret leakage)
app.use(requestLoggerMiddleware);

// 3. Standard body parsing with strict 100kb limit
app.use(express.json({ limit: '100kb' }));

// 4. Diagnostics & health routes
app.use('/health', healthRoutes);

// 5. Gateway v1 reverse proxy routes (rate-limited before forwarding)
app.use('/gateway/v1', gatewayRoutes);

// 6. Catch-all 404 handler for unmatched routes
app.use((req, res, next) => {
  next(new NotFoundError(`The requested endpoint does not exist.`));
});

// 7. Central JSON error handler
app.use(errorHandler);

module.exports = app;
