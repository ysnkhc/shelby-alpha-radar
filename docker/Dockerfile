# ── Build stage ────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx prisma generate --schema=src/database/prisma/schema.prisma
RUN npm run build

# ── Production stage ──────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Security: run as non-root user
RUN addgroup -S shelby && adduser -S shelby -G shelby

# Install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy Prisma schema + generate client for production
COPY src/database/prisma/schema.prisma ./src/database/prisma/schema.prisma
RUN npx prisma generate --schema=src/database/prisma/schema.prisma

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Copy migration script
COPY scripts/ ./scripts/

USER shelby

EXPOSE 3000

CMD ["node", "dist/index.js"]
