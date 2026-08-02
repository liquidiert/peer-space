# Multi-stage Dockerfile for PeerSpace Application (Vue + Hono)
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies for building
RUN npm ci

# Copy application source
COPY . .

# Build application (Vite Vue client build + Esbuild Hono server bundling)
RUN npm run build

# Production image
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy package manifests & install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built application output from builder stage
COPY --from=builder /app/dist ./dist

# Expose server port 3000
EXPOSE 3000

# Start Hono server
CMD ["node", "dist/server.js"]
