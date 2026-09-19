/**
 * Nexgent AI Trading Engine
 * Copyright (C) 2026 Nexgent AI
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Attribution Notice:
 * If you publicly deploy, distribute, or operate a modified or unmodified
 * version of this software, you must preserve the following attribution
 * in a reasonable and prominent location within the user interface or
 * documentation:
 *
 * "Powered by Nexgent AI – https://nexgent.ai"
 */

/**
 * Main application entry point
 * 
 * Sets up Express server with middleware, routes, and error handling.
 */

// Load environment variables
// Priority: package .env (highest) > root .env (fallback)
import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Detect if running from dist (production) or src (development)
// In dev: __dirname = packages/backend/src
// In prod: __dirname = packages/backend/dist/backend/src
const isProduction = __dirname.includes('dist');

// Calculate paths that work for both dev and production
// packageRoot should always resolve to packages/backend/
const packageRoot = isProduction 
  ? resolve(__dirname, '../../../')  // dist/backend/src -> dist -> packages/backend
  : resolve(__dirname, '../');        // src -> packages/backend

const workspaceRoot = resolve(packageRoot, '../../');  // packages/backend -> nexgent

// Load root .env first (if exists, lower priority)
const rootEnvPath = resolve(workspaceRoot, '.env');
const rootEnv = config({ path: rootEnvPath });

// Load package .env second (overrides root, highest priority)
const packageEnvPath = resolve(packageRoot, '.env');
const packageEnv = config({ path: packageEnvPath, override: true });

// Debug: Log environment file loading
const packageKeys = packageEnv.parsed ? Object.keys(packageEnv.parsed) : [];
const _hasJupiterKey = packageKeys.some(key => key.includes('JUPITER') || key.includes('jupiter'));
const jupiterKeys = packageKeys.filter(key => key.toLowerCase().includes('jupiter'));

console.log('📁 Environment files:', {
  root: rootEnvPath,
  rootLoaded: rootEnv.parsed ? Object.keys(rootEnv.parsed).length + ' vars' : 'not found',
  package: packageEnvPath,
  packageLoaded: packageKeys.length + ' vars',
  jupiterKeySet: !!process.env.JUPITER_API_KEY,
  jupiterKeysFound: jupiterKeys.length > 0 ? jupiterKeys : 'none',
  allKeysSample: packageKeys.slice(0, 10).join(', ') + (packageKeys.length > 10 ? '...' : '')
});

// Explicitly set JUPITER_API_KEY if it's in the parsed env but not in process.env
// Check for case variations and whitespace issues
if (!process.env.JUPITER_API_KEY) {
  // Try exact match first
  let jupiterKey = packageEnv.parsed?.JUPITER_API_KEY || rootEnv.parsed?.JUPITER_API_KEY;
  
  // Try case-insensitive search if exact match failed
  if (!jupiterKey && packageEnv.parsed) {
    const foundKey = Object.keys(packageEnv.parsed).find(k => k.toUpperCase() === 'JUPITER_API_KEY');
    if (foundKey) {
      jupiterKey = packageEnv.parsed[foundKey];
      console.log(`⚠️  Found JUPITER_API_KEY with different case: ${foundKey}`);
    }
  }
  
  if (jupiterKey) {
    // Trim whitespace in case there are spaces
    process.env.JUPITER_API_KEY = String(jupiterKey).trim();
    console.log(`✅ Manually set JUPITER_API_KEY from .env (length: ${process.env.JUPITER_API_KEY.length})`);
  } else {
    console.error('❌ JUPITER_API_KEY not found in .env file!');
    console.error('   Make sure it\'s spelled exactly: JUPITER_API_KEY=your-key-here');
    console.error('   No spaces around the = sign, no quotes needed');
  }
}

// Ensure PORT is explicitly set from package .env if it exists
if (packageEnv.parsed?.PORT) {
  process.env.PORT = packageEnv.parsed.PORT;
}
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import apiRoutes from './api/index.js';
import { prisma } from './infrastructure/database/client.js';
import { SolPriceService } from '@/infrastructure/external/jupiter/price/sol-price-service.js';
import { wsServer } from './infrastructure/websocket/server.js';
import { priceUpdateManager } from './domain/prices/index.js';
import { initializeAutoTradeReentryManager, shutdownAutoTradeReentryManager } from './domain/trading/auto-trade-reentry-manager.service.js';
import { initializeAutoTradeReconciliationManager, shutdownAutoTradeReconciliationManager } from './domain/trading/auto-trade-reconciliation-manager.service.js';
import { initializeAutoTradeMarketCapMonitor, shutdownAutoTradeMarketCapMonitor } from './domain/trading/auto-trade-market-cap-monitor.service.js';
import type { Server } from 'http';
import { errorHandler, notFoundHandler } from '@/middleware/error-handler.js';
import { requestLogger } from '@/middleware/request-logger.js';
import { redisService } from '@/infrastructure/cache/redis-client.js';
import { cacheWarmer } from '@/infrastructure/cache/cache-warmer.js';
import { queueWorker } from '@/infrastructure/queue/queue-worker.js';
import { queueClient } from '@/infrastructure/queue/queue-client.js';
import { signalProcessor } from '@/domain/signals/signal-processor.service.js';
import { WalletLoader } from '@/infrastructure/wallets/wallet-loader.js';
import { walletStore } from '@/infrastructure/wallets/index.js';
import { balanceSnapshotScheduler } from '@/domain/balances/balance-snapshot-scheduler.js';
import { seedAdminAccount } from '@/infrastructure/database/seed-admin.js';

const app = express();
const PORT = parseInt(process.env.PORT || '4000', 10);

// Trust first proxy (e.g. nginx, Railway) so req.secure and req.ip are correct.
// Required for Helmet HSTS and correct client IP in logs/rate-limiting when behind TLS-terminating proxy.
app.set('trust proxy', 1);

// Store server instance for graceful shutdown
let server: Server | null = null;
let isShuttingDown = false;

// ============================================================================
// Middleware
// ============================================================================

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : process.env.NODE_ENV === 'production'
    ? [] // Must be set in production
    : ['http://localhost:3000'], // Default to Next.js dev server
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// Security headers (X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, etc.)
app.use(helmet());

app.use(cors(corsOptions));

// Body parsing middleware (1MB limit — trading API payloads are small)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request logging middleware (structured logging with request IDs)
app.use(requestLogger);

// ============================================================================
// Routes
// ============================================================================

// Legacy health endpoint (redirects to new versioned endpoint)
app.get('/health', (req: Request, res: Response) => {
  res.redirect('/api/v1/health');
});

// API routes (versioned)
app.use('/api', apiRoutes);

// 404 handler for undefined routes
app.use(notFoundHandler);

// ============================================================================
// Error Handling Middleware
// ============================================================================

/**
 * Global error handler
 * 
 * Catches all errors and returns appropriate HTTP responses.
 * Logs errors for debugging but doesn't expose sensitive information.
 */
app.use(errorHandler);

// ============================================================================
// Server Startup
// ============================================================================

/**
 * Start the Express server
 */
async function startServer() {
  try {
    // Validate required environment variables
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET environment variable is required');
    }

    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    // Initialize Redis
    console.log('🔌 Connecting to Redis...');
    await redisService.connect();

    // Seed admin account on first boot (no-op if a user already exists)
    console.log('👤 Checking admin account...');
    await seedAdminAccount();

    // Load wallets from environment variables
    console.log('🔑 Loading wallets from environment variables...');
    const walletLoader = new WalletLoader();
    const loadResult = walletLoader.loadWallets();

    if (loadResult.errors.length > 0) {
      console.error('⚠️  Wallet loading errors:');
      loadResult.errors.forEach(({ envKey, error }) => {
        console.error(`   ${envKey}: ${error}`);
      });
    }

    walletStore.initialize(loadResult.wallets);
    console.log(`✅ Loaded ${loadResult.wallets.size} wallet(s) from environment`);
    if (loadResult.wallets.size > 0) {
      const addresses = Array.from(loadResult.wallets.keys());
      console.log(`   Available addresses: ${addresses.join(', ')}`);
    }

    // Initialize queue workers
    queueWorker.initialize();

    // Initialize balance snapshot scheduler
    await balanceSnapshotScheduler.start();

    // Warm up cache
    // Run in background to not block startup, or await if critical
    // For ultra-low latency, we prefer to wait so first requests are fast
    await cacheWarmer.warmup();

    // Ensure signal processor is initialized (singleton pattern, but explicit for clarity)
    // The signal processor sets up event listeners in its constructor
    console.log('✅ Signal Processor initialized:', signalProcessor ? 'Yes' : 'No');
    console.log('✅ Signal Processor listening for signal_created events');

    // Initialize SOL price service (Jupiter-backed).
    // Never throws: a degraded price service must not block startup.
    const priceService = SolPriceService.getInstance();
    await priceService.initialize();

    // Initialize token metadata service
    const { tokenMetadataService } = await import('./infrastructure/external/solana/token-metadata-service.js');
    tokenMetadataService.initialize();

    // Debug: Log the port being used
    console.log(`Starting server on port: ${PORT} (from env: ${process.env.PORT || 'default 4000'})`);
    
    // Debug: Log environment variable loading status (helpful for troubleshooting)
    if (process.env.JUPITER_API_KEY) {
      console.log('✅ JUPITER_API_KEY: set');
    } else {
      console.warn('⚠️  JUPITER_API_KEY not found in environment variables');
    }

    // Wait a moment before starting server (helps with hot-reload)
    // Windows may hold the port briefly after the previous process exits
    // This delay gives the OS time to release the port
    await new Promise(resolve => setTimeout(resolve, 500));

    // Listen on all interfaces (0.0.0.0) to allow tunnel connections
    // Wrap in try-catch to handle port conflicts gracefully
    try {
      server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`🌐 Health check: http://localhost:${PORT}/health`);
        console.log(`🔐 Auth API: http://localhost:${PORT}/api/auth`);
      });

      // Handle server errors (e.g., port already in use)
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`❌ Port ${PORT} is already in use.`);
          console.error(`   This usually happens during hot-reload.`);
          console.error(`   tsx watch will automatically retry when a file changes.`);
          console.error(`   Or manually kill the process: netstat -ano | findstr :${PORT}`);
          // Exit immediately without triggering shutdown handlers
          // This prevents the uncaught exception from trying to close a server that wasn't started
          process.exit(1);
        } else {
          console.error('Failed to start server:', error);
          process.exit(1);
        }
      });
    } catch (error) {
      // This shouldn't happen since listen() doesn't throw synchronously
      // But handle it just in case
      console.error('Error creating server:', error);
      if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is in use. tsx watch will retry automatically.`);
      }
      process.exit(1);
    }

      // Initialize WebSocket server
      wsServer.initialize(server);

      // Initialize auto-trade re-entry manager
      initializeAutoTradeReentryManager();
      initializeAutoTradeReconciliationManager();
      initializeAutoTradeMarketCapMonitor();

      // Initialize price update manager (after WebSocket server)
      priceUpdateManager.initialize(wsServer);

      // Setup graceful shutdown
      setupGracefulShutdown();
  } catch (error) {
    console.error('Failed to start server:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      if (error.stack) {
        console.error('Stack trace:', error.stack);
      }
    }
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 * 
 * Closes the server and database connections when the process receives
 * termination signals (SIGTERM, SIGINT).
 */
function setupGracefulShutdown() {
  const shutdown = async (signal: string) => {
    // Prevent multiple shutdown attempts
    if (isShuttingDown) {
      console.log('Shutdown already in progress, forcing exit...');
      process.exit(0);
      return;
    }

    isShuttingDown = true;
    console.log(`\n${signal} received. Starting graceful shutdown...`);

    const shutdownTimeout = setTimeout(() => {
      console.log('⚠️  Shutdown taking too long, forcing exit...');
      process.exit(1);
    }, 10000); // 10 second timeout

    try {
      // Close HTTP server
      if (server) {
        console.log('🔄 Closing HTTP server...');
        
        // Force close all active connections first
        // This prevents hanging connections from keeping the port bound
        // Note: closeAllConnections() is available in Node.js 18.2.0+
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
          console.log('✅ All active connections closed');
        }
        
        await new Promise<void>((resolve) => {
          const closeTimeout = setTimeout(() => {
            console.log('⚠️  Server close timeout after 2s, forcing exit...');
            resolve();
          }, 2000); // 2 second timeout

          server!.close((err) => {
            clearTimeout(closeTimeout);
            if (err) {
              console.error('❌ Error closing server:', err);
            } else {
              console.log('✅ HTTP server closed');
            }
            // Always resolve to continue shutdown
            resolve();
          });
        }).catch((error) => {
          console.error('❌ Error during server close:', error);
        });
        
        // Ensure server is fully destroyed and remove listeners
        server.removeAllListeners();
        server = null; // Clear reference
      }

      // Shutdown auto-trade managers
      try {
        shutdownAutoTradeReentryManager();
        shutdownAutoTradeReconciliationManager();
        shutdownAutoTradeMarketCapMonitor();
      } catch (error) {
        console.error('❌ Error shutting down auto-trade managers:', error);
      }

      // Shutdown price update manager
      try {
        priceUpdateManager.shutdown();
      } catch (error) {
        console.error('❌ Error shutting down price update manager:', error);
      }

      // Shutdown WebSocket server
      try {
        wsServer.shutdown();
      } catch (error) {
        console.error('❌ Error shutting down WebSocket server:', error);
      }

      // Shutdown price service
      try {
        const priceService = SolPriceService.getInstance();
        priceService.shutdown();
      } catch (error) {
        console.error('❌ Error shutting down price service:', error);
      }

      // Close queue workers
      try {
        await queueWorker.closeAll();
      } catch (error) {
        console.error('❌ Error closing queue workers:', error);
      }

      // Close queue clients
      try {
        await queueClient.closeAll();
      } catch (error) {
        console.error('❌ Error closing queue clients:', error);
      }

      // Close Redis connection
      try {
        await redisService.disconnect();
      } catch (error) {
        console.error('❌ Error closing Redis connection:', error);
      }

      // Close database connections
      try {
        await prisma.$disconnect();
        console.log('✅ Database connections closed');
      } catch (error) {
        // Prisma might already be disconnected, which is fine
        if (error instanceof Error && !error.message.includes('already disconnected')) {
          console.error('❌ Error closing database connections:', error);
        } else {
          console.log('✅ Database connections already closed');
        }
      }

      clearTimeout(shutdownTimeout);
      console.log('👋 Shutdown complete');
      process.exit(0);
    } catch (error) {
      clearTimeout(shutdownTimeout);
      console.error('❌ Error during shutdown:');
      if (error instanceof Error) {
        console.error('  Message:', error.message);
        if (error.stack) {
          console.error('  Stack:', error.stack);
        }
      } else {
        console.error('  Error:', error);
      }
      process.exit(1);
    }
  };

  // Handle termination signals
  // Note: SIGINT (Ctrl+C) and SIGTERM should trigger graceful shutdown
  process.on('SIGTERM', () => {
    console.log('\n📡 SIGTERM signal received');
    void shutdown('SIGTERM');
  });
  
  process.on('SIGINT', () => {
    console.log('\n📡 SIGINT signal received (Ctrl+C)');
    void shutdown('SIGINT');
  });

  // Handle uncaught errors
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (!isShuttingDown) {
      void shutdown('unhandledRejection');
    }
  });

  process.on('uncaughtException', (error) => {
    // Don't trigger shutdown for port already in use errors
    // This happens during hot-reload and the server error handler already handled it
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      // Already logged by server error handler, just exit cleanly
      process.exit(1);
      return;
    }
    
    // Don't trigger shutdown if server was never successfully started
    // (indicated by server being null)
    if (!server) {
      console.error('Uncaught Exception during startup:', error);
      process.exit(1);
      return;
    }
    
    console.error('Uncaught Exception:', error);
    if (!isShuttingDown) {
      void shutdown('uncaughtException');
    } else {
      // If we're already shutting down, just exit
      process.exit(1);
    }
  });

  // Ensure process exits even if shutdown hangs
  // This is a safety net for cases where shutdown doesn't complete
  process.on('exit', (code) => {
    console.log(`\n🔚 Process exiting with code ${code}`);
  });
}

// Start server
startServer();
