const express = require('express');
const healthRoutes = require('./routes/health.routes');

const app = express();

// Standard middleware
app.use(express.json());

// Diagnostics & health routes
app.use('/health', healthRoutes);

// Catch-all 404 handler for unknown routes
app.use((req, res, next) => {
  res.status(404).json({
    error: 'not_found',
    message: 'The requested endpoint does not exist.',
    path: req.originalUrl
  });
});

// Central error handler
// Note: Must retain 4 arguments (err, req, res, next) for Express to recognise it as an error middleware
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const errorCode = err.code || 'internal_server_error';
  const errorMessage = statusCode === 500
    ? 'An unexpected internal server error occurred.'
    : (err.message || 'Error processing request');

  res.status(statusCode).json({
    error: errorCode,
    message: errorMessage
  });
});

module.exports = app;
