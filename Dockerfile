# ==============================================================================
# ShieldAPI — Production Multi-Stage Dockerfile
# ==============================================================================
# Base image: Official Node.js 22 LTS on Alpine Linux for minimal attack surface
FROM node:22-alpine

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Install production dependencies only (pinned via package-lock.json)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code
COPY src/ ./src/

# Run as non-root user provided by node base image
USER node

# Default port exposed by the gateway
EXPOSE 3000

# Default entry point (starts Express gateway server)
CMD ["node", "src/server.js"]

