# 🚨 Real-Time Shelby Alpha Radar

Shelby Alpha Radar is a live intelligence layer for the Shelby network.

It detects behavioral patterns across wallets and surfaces high-signal events in real-time — before they become obvious.

Instead of searching blobs, you see what's happening on Shelby as it happens.

![Alpha Radar UI](frontend/screenshot.png)

### Example signals:

- 🔴 5 wallets uploaded .json within 2 minutes
- 🔴 Wallet activity surged 5x vs its average
- 🔴 New wallet uploaded 4 blobs in 3 minutes

---

## Why this matters

Shelby is a new data layer.

This radar helps detect:

- Emerging usage patterns
- Coordinated behavior
- Early network activity

It acts as a discovery engine for Shelby before trends become visible.

## Architecture

```
Shelby Testnet
     │
     ▼
  Crawler ──→ Queue (Redis) ──→ Worker
                                  │
                              RPC Fetch
                                  │
                                  ▼
                            PostgreSQL
                                  │
                          Alpha Detector
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
                REST API      SSE Feed      DB Storage
                    │             │
                    ▼             ▼
               Frontend UI (Live Radar)
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| API Server | Fastify |
| Database | PostgreSQL + Prisma |
| Queue | Redis + BullMQ |
| Real-Time | Server-Sent Events (SSE) |
| Frontend | Vanilla HTML/CSS/JS |
| Chain | Aptos SDK (Shelby testnet) |

## Run Locally

### Prerequisites

- Node.js 18+
- Docker Desktop (for PostgreSQL + Redis)

### Setup

```bash
# Clone
git clone https://github.com/ysnkhc/shelby-alpha-radar.git
cd shelby-alpha-radar

# Start infrastructure
cd backend
docker compose up -d

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Run database migrations
npx prisma migrate dev --schema=src/database/prisma/schema.prisma

# Start the indexer + API
npx tsx src/index.ts
```

### Open the UI

Open `frontend/index.html` in your browser, or deploy it to Vercel.

The frontend connects to `http://localhost:3000` by default.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/blobs/recent` | Latest indexed blobs |
| GET | `/alpha` | All alpha signals |
| GET | `/alpha/high` | High-priority signals only |
| GET | `/alpha/:owner` | Signals for a specific wallet |
| GET | `/stats` | Network statistics |
| GET | `/leaders` | Top wallets by activity |
| GET | `/trends/files` | Trending file types |
| GET | `/owners/:owner` | Wallet profile |
| GET | `/owners/:owner/timeline` | Recent wallet activity |
| GET | `/ws/alpha` | SSE live feed |
| GET | `/ws/alpha?minPriority=HIGH` | Filtered live feed |
| GET | `/ws/alpha?owner=0x...` | Wallet watchlist |

## Deployment

### Backend → Railway

1. New Project → Deploy from GitHub
2. Set root directory: `/backend`
3. Add PostgreSQL + Redis services
4. Set environment variables
5. Start command: `npx tsx src/index.ts`

### Frontend → Vercel

1. Import repo → Set root: `/frontend`
2. Update `API_BASE` in `script.js` with your Railway URL
3. Deploy

---

Built for the Shelby ecosystem.
