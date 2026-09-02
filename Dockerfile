# Multi-stage Dockerfile for standard-api
FROM node:20-alpine AS base

# Install system dependencies
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Dependencies stage
FROM base AS deps
COPY package*.json ./
RUN npm install --omit=dev

# Production runner stage
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Copy node_modules and project files
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY examples ./examples

# Create sessions storage directory and ensure permissions
RUN mkdir -p /app/sessions && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/instance/list || exit 1

CMD ["npm", "start"]
