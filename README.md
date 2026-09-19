# Nexgent AI

<div align="center">

**Open-source Solana AI agent trading automation framework**

[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

[Documentation](#-documentation) • [Quick Start](#-quick-start) • [Architecture](#architecture) • [Contributing](#-contributing)

</div>

---

## 🎯 What is Nexgent AI?

Nexgent AI is an open-source platform for building and managing AI-powered trading agents on the Solana blockchain. Create automated trading strategies, monitor positions in real-time, and execute trades with ultra-low latency.

### Key Features

- 🤖 **AI Trading Agents** - Create and configure multiple trading agents with custom strategies
- ⚡ **Ultra-Low Latency** - Sub-100ms signal processing to trade execution
- 📊 **Real-Time Monitoring** - Live position tracking, performance analytics, and WebSocket updates
- 🔒 **Secure Wallet Management** - Non-custodial wallet support with simulation and live trading modes
- 🎯 **Advanced Stop Loss** - Multiple stop loss modes (fixed, exponential, zones, custom) with sub-1ms evaluation
- 📉 **Dollar Cost Averaging (DCA)** - Automatic re-buys on price dips to lower average cost basis
- ⏱️ **Stale Trade Auto-Close** - Automatically close positions with modest gains/losses after minimum hold time
- 🛡️ **Price Impact Protection** - Configurable maximum price impact limits per trade
- 📈 **Price Feeds** - Real-time price data from Pyth Network, DexScreener, and Jupiter
- 🔄 **Trade Execution** - Automated swaps via Jupiter Aggregator API
- 📱 **Modern Dashboard** - Beautiful, responsive UI built with Next.js and shadcn/ui
- 📊 **Performance Analytics** - Balance snapshots, historical swaps, transaction history, and performance metrics
- 🔌 **System Health Monitoring** - Real-time health checks for database, Redis, and queue services
- 📡 **Webhooks** - External integrations for trading signals and notifications
- 📈 **Prometheus Metrics** - Comprehensive observability with Prometheus-compatible metrics

## 🏗️ Architecture

Nexgent AI is built as a **monorepo** with three main packages:

```
nexgent/
├── packages/
│   ├── backend/          # Express API + WebSocket server
│   ├── frontend/         # Next.js dashboard
│   └── shared/           # Shared TypeScript types & utilities
├── docker-compose.yml    # Local development setup
└── railway.json          # Railway deployment config
```

### How It Works

1. **Trading Signals** → External signals trigger agent evaluation
2. **Agent Processing** → Agents check eligibility (balance, config, blacklist/whitelist) and execute trades
3. **Trade Execution** → Jupiter Aggregator executes swaps on Solana (simulation or live mode)
4. **Position Management** → Real-time tracking with Redis caching and PostgreSQL persistence
5. **Price Monitoring** → Real-time Solana price via WebSocket (Pyth Network SSE), 1-second polling for other tokens with instant WebSocket delivery
6. **Stop Loss Evaluation** → Sub-1ms in-memory evaluation with multiple calculation modes
7. **DCA Management** → Automatic re-buys when price drops to configured levels
8. **Stale Trade Detection** → Auto-close positions with modest gains/losses after hold period
9. **WebSocket Updates** → Live updates to the frontend dashboard (positions, prices, balances)

### Performance Targets

- **Signal Processing**: Sub-100ms from signal to trade execution
- **Stop Loss Evaluation**: Sub-1ms in-memory evaluation
- **Stop Loss Execution**: Sub-500ms from trigger to on-chain execution
- **Price Updates**: Real-time Solana price via WebSocket (Pyth Network SSE), 1-second polling for other tokens with instant WebSocket delivery

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ and **pnpm** 8+
- **PostgreSQL** 14+ (or use Docker Compose)
- **Redis** 6.0+ (or use Docker Compose)

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/Nexgent-ai/nexgent-open-source-trading-engine.git
   cd nexgent-open-source-trading-engine
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Set up environment variables**
   ```bash
   # Backend
   cd packages/backend
   cp env.example .env
   # Edit .env with your database and Redis URLs
   
   # Frontend
   cd ../frontend
   cp env.example .env.local
   # Generate secrets: pnpm generate-secret
   ```

4. **Start services with Docker Compose**
   ```bash
   # From root directory
   docker-compose up -d
   ```

5. **Run database migrations**
   ```bash
   pnpm --filter backend db:migrate
   ```

6. **Start development servers**
   ```bash
   # From root directory
   pnpm dev
   ```

7. **Access the application**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:4000
   - API Docs: http://localhost:4000/api/v1/health

### Generate Secrets

```bash
# Frontend (NextAuth.js)
pnpm generate-secret

# Backend (JWT)
pnpm generate-secret:backend
```

## 📦 Monorepo Structure

### `packages/backend`

Express.js API server with WebSocket support built with Domain-Driven Design (DDD) principles. Handles:
- Trading signal processing and agent eligibility evaluation
- Trade execution via Jupiter (purchases, sales, DCA buys)
- Position and balance management with Redis caching
- Real-time price feeds (Solana via WebSocket SSE, other tokens via 1-second polling)
- Stop loss evaluation (multiple modes: fixed, exponential, zones, custom)
- DCA (Dollar Cost Averaging) management
- Stale trade auto-close detection
- Price impact protection
- WebSocket connections for live updates
- System health monitoring and Prometheus metrics
- Webhook endpoints for external integrations

**Tech Stack**: Express, TypeScript, Prisma, Redis, BullMQ, WebSocket, Prometheus

**Key Scripts**:
```bash
pnpm --filter backend dev          # Start dev server
pnpm --filter backend build        # Build for production
pnpm --filter backend db:migrate    # Run migrations
pnpm --filter backend test          # Run tests
```

📖 [Backend Documentation](./packages/backend/README.md)

### `packages/frontend`

Next.js 15 dashboard with App Router. Features:
- Agent management and configuration with advanced trading settings
- Real-time position tracking with DCA purchase history
- Performance analytics with balance snapshots and historical charts
- Wallet management with deposit/withdraw capabilities
- Trading signal monitoring with export functionality
- System health monitoring dashboard
- Data source connection management
- Transaction history and trade detail views

**Tech Stack**: Next.js 15, TypeScript, Tailwind CSS, shadcn/ui, React Query, NextAuth.js

**Key Scripts**:
```bash
pnpm --filter frontend dev          # Start dev server
pnpm --filter frontend build        # Build for production
pnpm --filter frontend type-check   # Type check
```

📖 [Frontend Documentation](./packages/frontend/README.md)

### `packages/shared`

Shared TypeScript types, utilities, and validation schemas used by both frontend and backend.

**Contents**:
- API request/response types
- Trading configuration types
- Validation schemas (Zod)
- Utility functions

## 🛠️ Tech Stack

### Backend
- **Runtime**: Node.js 18+ (ESM)
- **Framework**: Express.js 4.18+
- **Database**: PostgreSQL 14+ with Prisma ORM
- **Cache/Queue**: Redis 6.0+ with BullMQ
- **Blockchain**: Solana Web3.js
- **APIs**: Jupiter Aggregator, DexScreener, Pyth Network

### Frontend
- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript 5.7+
- **Styling**: Tailwind CSS
- **Components**: shadcn/ui
- **State**: React Query (TanStack Query)
- **Auth**: NextAuth.js
- **Charts**: Recharts

### Infrastructure
- **Package Manager**: pnpm (workspaces)
- **Deployment**: Vercel (frontend), Railway (backend)
- **Containerization**: Docker & Docker Compose

## 📚 Documentation

- **[DEVELOPMENT.md](./DEVELOPMENT.md)** - Complete development environment setup guide
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** - Contribution guidelines and development workflow
- **[Backend README](./packages/backend/README.md)** - Detailed backend architecture and API docs
- **[Frontend README](./packages/frontend/README.md)** - Frontend architecture and component docs
- **[Security Policy](./SECURITY.md)** - Security guidelines and vulnerability reporting

## 🔧 Available Scripts

### Development
```bash
pnpm dev                    # Start both frontend and backend
pnpm dev:backend            # Start backend only
pnpm dev:frontend           # Start frontend only
pnpm dev:clean              # Clean and start fresh
```

### Building
```bash
pnpm build                  # Build all packages
pnpm build:backend          # Build backend only
pnpm build:frontend         # Build frontend only
pnpm build:skip-tests       # Build without running tests
```

### Testing
```bash
pnpm test                   # Run all package tests
pnpm test:backend           # Run backend tests (unit + integration)
pnpm --filter backend test:unit         # Backend unit tests only
pnpm --filter backend test:integration  # Backend integration tests only
```

### Code Quality
```bash
pnpm lint                   # Lint all packages
pnpm type-check             # Type check all packages
```

## 🚢 Deployment

### Quick Deploy (Vercel + Railway)

1. **Fork the repository** on GitHub
2. **Deploy frontend** to Vercel
3. **Deploy backend** to Railway with PostgreSQL and Redis
4. **Configure environment variables** in both platforms
5. **Run migrations** on Railway

### Environment Variables

See `packages/backend/env.example` and `packages/frontend/env.example` for required variables.

**Critical variables**:
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_HOST` / `REDIS_PORT` - Redis connection
- `JWT_SECRET` - Backend authentication secret
- `NEXTAUTH_SECRET` - Frontend authentication secret
- `JUPITER_API_KEY` - Required. Used for swaps, token metrics and price data

## 🔒 Security

**Important**: When running Nexgent AI, you are responsible for securing your own wallet private keys and managing your trading operations. Security is critical.

- 🔐 **Never commit** `.env` files or private keys to version control
- 🔑 **Generate strong secrets** using `pnpm generate-secret`
- 🛡️ **Use simulation mode** for testing before live trading
- 💰 **Only fund wallets** with the minimum SOL needed for trading
- 📋 **Review** [SECURITY.md](./SECURITY.md) for comprehensive security guidelines

**Report vulnerabilities**: Use GitHub's "Report a vulnerability" feature or email contact@nexgent.ai

## 🤝 Contributing

Contributions are welcome! Please see our [Contributing Guide](./CONTRIBUTING.md) for detailed information.

Quick start:
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes following our [development guidelines](./DEVELOPMENT.md)
4. Commit your changes (`git commit -m 'feat: add amazing feature'`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

For detailed setup instructions, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## 📄 License

Nexgent AI Trading Engine
Copyright (C) 2026 Nexgent AI

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

Attribution Notice:
If you publicly deploy, distribute, or operate a modified or unmodified
version of this software, you must preserve the following attribution
in a reasonable and prominent location within the user interface or
documentation:

"Powered by Nexgent AI – https://nexgent.ai"

See the [LICENSE](LICENSE) file for the full GPL-3.0 license text.

## 🙏 Acknowledgments

- [Solana](https://solana.com/) - Blockchain infrastructure
- [Jupiter Aggregator](https://jup.ag/) - Token swap execution
- [Pyth Network](https://pyth.network/) - Price oracles
- [DexScreener](https://dexscreener.com/) - Token analytics
- [Next.js](https://nextjs.org/) - Frontend framework
- [shadcn/ui](https://ui.shadcn.com/) - UI components

## 📞 Support

- **Documentation**: See the package README files and guides above
- **Issues**: [GitHub Issues](https://github.com/Nexgent-ai/nexgent-open-source-trading-engine/issues)
- **Security**: [SECURITY.md](./SECURITY.md)
- **Email**: contact@nexgent.ai

---

<div align="center">

**Built with ❤️ for the Solana ecosystem**

[Website](https://nexgent.ai) • [Documentation](https://docs.nexgent.ai) • [GitHub](https://github.com/Nexgent-ai/nexgent-open-source-trading-engine)

</div>
