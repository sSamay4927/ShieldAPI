const express = require('express');
const requestIdMiddleware = require('./middleware/requestId');
const { requestLoggerMiddleware } = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health.routes');
const { NotFoundError } = require('./utils/errors');

const app = express();

// 1. Request ID assignment and propagation (runs on every incoming request)
app.use(requestIdMiddleware);

// 2. Structured request logging (safe, no secret leakage)
app.use(requestLoggerMiddleware);

// 3. Standard body parsing
app.use(express.json());

// 4. Diagnostics & health routes
app.use('/health', healthRoutes);

// 5. Catch-all 404 handler for unmatched routes
app.use((req, res, next) => {
  next(new NotFoundError(`The requested endpoint does not exist.`));
});

// 6. Central JSON error handler
app.use(errorHandler);

module.exports = app;
