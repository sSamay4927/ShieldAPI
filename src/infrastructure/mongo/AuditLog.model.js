const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: [true, 'eventId is required'],
      unique: true,
      index: true
    },
    occurredAt: {
      type: Date,
      required: [true, 'occurredAt timestamp is required'],
      default: Date.now
    },
    route: {
      type: String,
      required: [true, 'route is required'],
      trim: true
    },
    method: {
      type: String,
      required: [true, 'method is required'],
      uppercase: true,
      trim: true
    },
    policyId: {
      type: String,
      required: [true, 'policyId is required'],
      default: 'default',
      trim: true
    },
    identityType: {
      type: String,
      required: [true, 'identityType is required'],
      enum: {
        values: ['api-key', 'ip'],
        message: '{VALUE} is not a valid identityType (must be "api-key" or "ip")'
      }
    },
    identityDigest: {
      type: String,
      required: [true, 'identityDigest is required'],
      trim: true
      // Note: Must be the HMAC-SHA256 digest of the identity. Raw keys/IPs are forbidden.
    },
    decision: {
      type: String,
      required: [true, 'decision is required'],
      enum: {
        values: ['RATE_LIMITED', 'UPSTREAM_ERROR'],
        message: '{VALUE} is not a valid decision (must be "RATE_LIMITED" or "UPSTREAM_ERROR")'
      }
    },
    requestId: {
      type: String,
      required: [true, 'requestId is required'],
      trim: true
    },
    limit: {
      type: Number,
      required: [true, 'limit is required'],
      min: [1, 'limit must be at least 1']
    },
    windowMs: {
      type: Number,
      required: [true, 'windowMs is required'],
      min: [1, 'windowMs must be at least 1']
    },
    retryAfterMs: {
      type: Number,
      required: [true, 'retryAfterMs is required'],
      min: [0, 'retryAfterMs cannot be negative']
    },
    expireAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: false,
    versionKey: false
  }
);

// Indexes specified in Blueprint Section 6.2:
// 1. Time-range investigation index
AuditLogSchema.index({ occurredAt: -1 });

// 2. Client-specific historical violation lookup
AuditLogSchema.index({ identityDigest: 1, occurredAt: -1 });

// 3. Document TTL cleanup index (asynchronous MongoDB background deletion)
AuditLogSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0, sparse: true });

const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);

module.exports = AuditLog;
