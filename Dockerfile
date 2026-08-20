# Stage 1: Build TypeScript source code
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests and TypeScript configuration
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies needed for build)
RUN npm ci

# Copy source files
COPY src/ ./src

# Compile TypeScript to JavaScript in dist/
RUN npm run build

# Remove development dependencies to keep production footprint minimal
RUN npm prune --production

# Stage 2: Production runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache curl

# Copy package metadata
COPY package*.json ./

# Copy built application and production dependencies from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Start the application
CMD ["node", "dist/index.js"]
