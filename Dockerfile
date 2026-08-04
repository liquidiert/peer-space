# Multi-stage Dockerfile for PeerSpace Application (Vue + Hono) with Bun
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock* ./

# Install dependencies for building
RUN bun install

# Copy application source
COPY . .

# Build application (Vite Vue client build + Esbuild Hono server bundling)
RUN bun run build

# Production image
FROM oven/bun:1-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy package manifests & install production dependencies only
COPY package.json bun.lock* ./
RUN bun install --production --verbose

# Copy built application output from builder stage
COPY --from=builder /app/dist ./dist

# Expose server port 3000
EXPOSE 3000

# Start Hono server with Bun
CMD ["bun", "dist/server.js"]
