/**
 * Price Update Manager
 * 
 * Manages automatic price polling for tokens with active positions.
 * Polls DexScreener API and broadcasts updates via WebSocket.
 * Integrates with existing PriceFeedService for rate limiting and batching.
 */

import { priceFeedService, liquidityCheckService } from '@/infrastructure/external/dexscreener/index.js';
import { redisPriceService } from '@/infrastructure/cache/redis-price-service.js';
import { redisAgentService } from '@/infrastructure/cache/redis-agent-service.js';
import { redisBalanceService } from '@/infrastructure/cache/redis-balance-service.js';
import { idempotencyService } from '@/infrastructure/cache/idempotency-service.js';
import { positionEventEmitter } from '../trading/position-events.js';
import { positionService } from '../trading/position-service.js';
import { stopLossManager } from '../trading/stop-loss-manager.service.js';
import { takeProfitManager } from '../trading/take-profit-manager.service.js';
import { dcaManager } from '../trading/dca-manager.service.js';
import { evaluateAutoTradeMarketCapGuard } from '../trading/auto-trade-market-cap-guard.js';
import { tradingExecutor } from '../trading/trading-executor.service.js';
import { configService } from '../trading/config-service.js';
import { prisma } from '@/infrastructure/database/client.js';
import type { TokenPrice } from '@/infrastructure/external/dexscreener/types.js';
import type { OpenPosition } from '@nexgent/shared';
import { priceUpdateLatency, priceUpdateCount, stopLossEvaluationLatency, stopLossTriggerCount, staleTradeTriggerCount, dcaTriggerCount, dcaExecutionLatency, errorCount } from '@/infrastructure/metrics/metrics.js';
import type { AgentTradingConfig } from '@nexgent/shared';
import logger from '@/infrastructure/logging/logger.js';

/**
 * Cached price data
 */
interface CachedPrice {
  priceSol: number;
  priceUsd: number;
  timestamp: Date;
}

/**
 * Token tracking information
 */
interface TokenTracking {
  tokenAddress: string; // Normalized (lowercase) for lookups
  originalTokenAddress: string; // Original case from database (for API calls)
  tokenSymbol: string;
  agents: Set<string>; // Agent IDs that have positions in this token
  lastUpdate: Date | null;
}

/**
 * Price Update Manager
 * 
 * Singleton service for managing price updates for active positions.
 */
class PriceUpdateManager {
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL = 1500; // 1.5 seconds (reduced to avoid Jupiter rate limits)
  /**
   * Slower cadence used when no position tokens are tracked and the only thing
   * being polled is SOL itself. Keeps the app-wide SOL/USD price fresh without
   * holding a 1.5s poll open for a single token.
   */
  private readonly IDLE_POLL_INTERVAL = 30_000; // 30 seconds
  /** Cadence the current interval timer was created with. */
  private currentPollIntervalMs: number | null = null;
  private readonly CACHE_TTL = 2000; // 2 seconds (slightly longer than poll interval)
  private readonly SOL_TOKEN_ADDRESS = 'So11111111111111111111111111111111111111112';

  // Guard to prevent concurrent polling
  private isPolling = false;

  // Track tokens that need price updates
  private trackedTokens: Map<string, TokenTracking> = new Map(); // tokenAddress -> tracking

  // Cache prices to avoid unnecessary API calls
  // Note: Now we use Redis primarily, but keep local cache for very fast access
  private priceCache: Map<string, CachedPrice> = new Map(); // tokenAddress -> cached price

  // In-memory cache for market-cap guard rejections to avoid repeated external API calls.
  // Key: tokenAddress (normalized), Value: rejection expiry timestamp (ms).
  private readonly MARKET_CAP_GUARD_TTL_MS = 60_000; // 60 seconds
  private marketCapGuardRejectCache: Map<string, number> = new Map();

  // Reference to WebSocket server (set during initialization)
  private wsServer: {
    broadcastPriceUpdate: (agentId: string, tokenAddress: string, price: number, priceUsd: number) => void;
    broadcastPriceUpdates: (agentId: string, updates: Array<{ tokenAddress: string; price: number; priceUsd: number }>) => void;
  } | null = null;

  /**
   * Initialize price update manager
   * 
   * @param wsServer - WebSocket server instance for broadcasting
   */
  initialize(wsServer: {
    broadcastPriceUpdate: (agentId: string, tokenAddress: string, price: number, priceUsd: number) => void;
    broadcastPriceUpdates: (agentId: string, updates: Array<{ tokenAddress: string; price: number; priceUsd: number }>) => void;
  }): void {
    if (this.pollInterval) {
      logger.warn('Price update manager already initialized');
      return;
    }

    this.wsServer = wsServer;

    // Set up position event listeners
    this.setupPositionEventListeners();

    // Start polling
    this.startPolling();

    logger.info('Price update manager initialized');
  }

  // Store listener references to allow removal
  private positionCreatedListener?: (event: import('../trading/position-events.js').PositionCreatedEvent) => Promise<void>;
  private positionUpdatedListener?: (event: import('../trading/position-events.js').PositionUpdatedEvent) => Promise<void>;
  private positionClosedListener?: (event: import('../trading/position-events.js').PositionClosedEvent) => Promise<void>;

  /**
   * Set up position event listeners to track tokens
   * Idempotent: removes existing listeners before adding new ones to prevent duplicates
   */
  private setupPositionEventListeners(): void {
    // Remove existing listeners if they exist (prevents duplicates on re-initialization)
    if (this.positionCreatedListener) {
      positionEventEmitter.removeListener('position_created', this.positionCreatedListener);
    }
    if (this.positionUpdatedListener) {
      positionEventEmitter.removeListener('position_updated', this.positionUpdatedListener);
    }
    if (this.positionClosedListener) {
      positionEventEmitter.removeListener('position_closed', this.positionClosedListener);
    }

    // Create and store listener references
    this.positionCreatedListener = async (event: import('../trading/position-events.js').PositionCreatedEvent) => {
      await this.addTokenTracking(event.position.tokenAddress, event.position.tokenSymbol, event.agentId);
    };
    this.positionUpdatedListener = async (event: import('../trading/position-events.js').PositionUpdatedEvent) => {
      await this.addTokenTracking(event.position.tokenAddress, event.position.tokenSymbol, event.agentId);
    };
    this.positionClosedListener = async (event: import('../trading/position-events.js').PositionClosedEvent) => {
      await this.removeTokenTracking(event.agentId, event.tokenAddress);
    };

    // When position is created, add token to tracking
    positionEventEmitter.on('position_created', this.positionCreatedListener);

    // When position is updated, ensure token is tracked
    positionEventEmitter.on('position_updated', this.positionUpdatedListener);

    // When position is closed, remove agent from tracking for that specific token
    positionEventEmitter.on('position_closed', this.positionClosedListener);
  }

  /**
   * Add token to tracking list
   */
  private async addTokenTracking(tokenAddress: string, tokenSymbol: string, agentId: string): Promise<void> {
    // Normalize token address to lowercase for consistent lookups
    const normalizedAddress = tokenAddress.toLowerCase();
    const tracking = this.trackedTokens.get(normalizedAddress);

    if (tracking) {
      // Token already tracked, just add agent
      tracking.agents.add(agentId);
      logger.debug({ agentId, tokenAddress: normalizedAddress, tokenSymbol }, 'Added agent to token tracking');
    } else {
      // New token to track - preserve original case for API calls
      this.trackedTokens.set(normalizedAddress, {
        tokenAddress: normalizedAddress, // Normalized for lookups
        originalTokenAddress: tokenAddress, // Original case for API calls
        tokenSymbol,
        agents: new Set([agentId]),
        lastUpdate: null,
      });
      logger.info({ agentId, tokenAddress: normalizedAddress, tokenSymbol }, 'Started tracking token for agent');
    }
  }

  /**
   * Remove agent from token tracking for a specific token
   * If no agents left for token, remove token from tracking
   */
  private async removeTokenTracking(agentId: string, tokenAddress: string): Promise<void> {
    // Normalize token address to lowercase for consistent lookups
    const normalizedAddress = tokenAddress.toLowerCase();
    const tracking = this.trackedTokens.get(normalizedAddress);
    if (!tracking) {
      return; // Token not tracked
    }

    // Remove agent from tracking
    tracking.agents.delete(agentId);

    // If no agents left for this token, remove it from tracking
    if (tracking.agents.size === 0) {
      this.trackedTokens.delete(normalizedAddress);
      this.priceCache.delete(normalizedAddress);
      logger.info({ tokenAddress: normalizedAddress }, 'Stopped tracking token (no agents left)');
    } else {
      logger.debug({ agentId, tokenAddress: normalizedAddress, remainingAgents: tracking.agents.size }, 'Removed agent from token tracking');
    }
  }

  /**
   * Refresh tracked tokens from active positions
   * Called periodically to ensure tracking is up to date
   */
  private async refreshTrackedTokens(): Promise<void> {
    try {
      // Get all active positions from database
      const positions = await prisma.agentPosition.findMany({
        select: {
          agentId: true,
          tokenAddress: true,
          tokenSymbol: true,
        },
      });

      // Build new tracking map
      const newTracking = new Map<string, TokenTracking>();

      for (const position of positions) {
        // Normalize token address to lowercase for consistent lookups
        const normalizedAddress = position.tokenAddress.toLowerCase();
        const existing = newTracking.get(normalizedAddress);
        if (existing) {
          existing.agents.add(position.agentId);
        } else {
          newTracking.set(normalizedAddress, {
            tokenAddress: normalizedAddress, // Normalized for lookups
            originalTokenAddress: position.tokenAddress, // Original case for API calls
            tokenSymbol: position.tokenSymbol,
            agents: new Set([position.agentId]),
            lastUpdate: this.trackedTokens.get(normalizedAddress)?.lastUpdate || null,
          });
        }
      }

      logger.debug({ tokenCount: newTracking.size, positionCount: positions.length }, 'Refreshed token tracking');

      // Update tracking (keep lastUpdate timestamps where possible)
      this.trackedTokens = newTracking;

      // The map was rebuilt from positions, which does not include SOL - put it
      // back, then match the poll cadence to whatever is now tracked.
      this.ensureSolTracked();
      this.applyPollInterval();

      // Remove cached prices for tokens no longer tracked
      for (const tokenAddress of this.priceCache.keys()) {
        if (!this.trackedTokens.has(tokenAddress)) {
          this.priceCache.delete(tokenAddress);
        }
      }

      // Restore SOL's last-update timestamp, which the rebuild above discarded.
      const solTracking = this.trackedTokens.get(this.SOL_TOKEN_ADDRESS.toLowerCase());
      if (solTracking && !solTracking.lastUpdate) {
        solTracking.lastUpdate = this.priceCache.get(this.SOL_TOKEN_ADDRESS.toLowerCase())?.timestamp ?? null;
      }
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }, 'Error refreshing tracked tokens');
    }
  }

  /**
   * Start price polling
   */
  private startPolling(): void {
    if (this.pollInterval) {
      return;
    }

    // SOL is always tracked so the app-wide SOL/USD price stays fresh even with
    // no open positions. When positions exist it rides along in the same batch
    // request at no extra cost.
    this.ensureSolTracked();

    // Initial refresh of tracked tokens to load existing positions
    logger.info('Loading existing positions for tracking');
    this.refreshTrackedTokens().then(() => {
      logger.info({ tokenCount: this.trackedTokens.size }, 'Loaded tokens to track');
      this.applyPollInterval();
    });

    this.applyPollInterval();
  }

  /**
   * Add SOL to the tracked set if absent.
   *
   * SOL is tracked with no agents: it is polled for its price only, never
   * broadcast to a client or evaluated for stop loss.
   */
  private ensureSolTracked(): void {
    const normalizedAddress = this.SOL_TOKEN_ADDRESS.toLowerCase();
    if (this.trackedTokens.has(normalizedAddress)) {
      return;
    }

    this.trackedTokens.set(normalizedAddress, {
      tokenAddress: normalizedAddress,
      originalTokenAddress: this.SOL_TOKEN_ADDRESS,
      tokenSymbol: 'SOL',
      agents: new Set<string>(),
      lastUpdate: null,
    });
  }

  /**
   * Cadence the poller should currently run at.
   *
   * Fast while any position token is tracked; slow when SOL is all that's left.
   */
  private desiredPollIntervalMs(): number {
    const hasPositionTokens = Array.from(this.trackedTokens.values())
      .some(tracking => tracking.agents.size > 0);

    return hasPositionTokens ? this.POLL_INTERVAL : this.IDLE_POLL_INTERVAL;
  }

  /**
   * Create or replace the interval timer when the desired cadence changes.
   */
  private applyPollInterval(): void {
    const desired = this.desiredPollIntervalMs();

    if (this.pollInterval && this.currentPollIntervalMs === desired) {
      return;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.pollInterval = setInterval(async () => {
      await this.pollPrices();
    }, desired);
    this.currentPollIntervalMs = desired;

    logger.info({
      intervalSeconds: desired / 1000,
      mode: desired === this.POLL_INTERVAL ? 'active' : 'idle',
    }, 'Price polling interval set');
  }

  /**
   * Poll prices for all tracked tokens
   */
  private async pollPrices(): Promise<void> {
    // Guard: Skip if already polling (prevents overlapping executions)
    if (this.isPolling) {
      logger.debug('Skipping poll - previous poll still in progress');
      return;
    }

    this.isPolling = true;
    const startTime = Date.now();

    try {
      if (this.trackedTokens.size === 0) {
        return; // No tokens to poll (SOL is normally always present)
      }

      // Refresh tracked tokens periodically (every 5 polls = 50 seconds)
      const shouldRefresh = Math.random() < 0.2; // 20% chance each poll
      if (shouldRefresh) {
        await this.refreshTrackedTokens();
      }

      // Get list of token addresses to poll (use original case for API calls)
      const tokenAddresses = Array.from(this.trackedTokens.values()).map(
        tracking => tracking.originalTokenAddress
      );

      if (tokenAddresses.length === 0) {
        return;
      }

      // Fetch prices using PriceFeedService (handles batching and rate limiting)
      // Pass original case addresses for Jupiter API compatibility
      const prices = await priceFeedService.getMultipleTokenPrices(tokenAddresses);

      const duration = Date.now() - startTime;
      const durationSeconds = duration / 1000;

      // Record metrics
      priceUpdateLatency.observe({ source: 'dexscreener' }, durationSeconds);
      priceUpdateCount.inc({ source: 'dexscreener', status: 'success' });

      logger.debug({
        tokenCount: tokenAddresses.length,
        fetchedCount: prices.length,
        duration,
      }, 'Fetched prices from DexScreener');

      // Process each price update and collect updates per agent for batching
      const agentUpdates = new Map<string, Array<{ tokenAddress: string; price: number; priceUsd: number }>>();

      for (const price of prices) {
        const processed = await this.processPriceUpdate(price, agentUpdates);
        if (!processed) {
          continue; // Price was cached or token not tracked
        }
      }

      // Broadcast batched updates to each agent
      if (this.wsServer && agentUpdates.size > 0) {
        for (const [agentId, updates] of agentUpdates.entries()) {
          if (updates.length > 0) {
            this.wsServer.broadcastPriceUpdates(agentId, updates);
          }
        }
      }

      // Log tokens that failed to fetch (if any)
      // Normalize addresses to lowercase for comparison
      const fetchedAddresses = new Set(prices.map(p => p.tokenAddress.toLowerCase()));
      const failedAddresses = tokenAddresses.filter(addr => !fetchedAddresses.has(addr.toLowerCase()));

      if (failedAddresses.length > 0) {
        priceUpdateCount.inc({ source: 'dexscreener', status: 'partial' });

        logger.warn({
          failedCount: failedAddresses.length,
          failedAddresses,
        }, 'Some tokens failed to fetch prices');

        // Check liquidity for failed tokens
        try {
          const liquidityResults = await liquidityCheckService.checkLiquidityBatch(failedAddresses);

          // Log liquidity check results and handle rug pulled tokens
          for (const result of liquidityResults) {
            // Only treat as rug pulled when we successfully checked (no fetch/API error)
            if (result.isRugPulled && !result.error) {
              // Token is rug pulled - log error and create burn transactions
              logger.error({
                tokenAddress: result.tokenAddress,
                hasLiquidity: result.hasLiquidity,
                liquiditySol: result.liquiditySol,
                liquidityUsd: result.liquidityUsd,
                hasPairs: result.hasPairs,
                pairCount: result.pairCount,
                thresholdSol: 10,
                error: result.error,
              }, 'Token identified as rug pulled (SOL liquidity < 10 SOL or no SOL pairs)');

              // Create burn transactions for all positions in this token
              await liquidityCheckService.createBurnTransactionsForRugPulledToken(result.tokenAddress);
            } else if (!result.hasLiquidity && result.hasPairs) {
              // Has pairs but no liquidity - drained (but above threshold somehow)
              logger.warn({
                tokenAddress: result.tokenAddress,
                hasLiquidity: result.hasLiquidity,
                liquiditySol: result.liquiditySol,
                liquidityUsd: result.liquidityUsd,
                hasPairs: result.hasPairs,
                pairCount: result.pairCount,
              }, 'Token has pairs but no SOL liquidity (drained)');
            } else if (result.hasLiquidity) {
              // Has liquidity but price fetch failed - different issue
              logger.warn({
                tokenAddress: result.tokenAddress,
                hasLiquidity: result.hasLiquidity,
                liquiditySol: result.liquiditySol,
                liquidityUsd: result.liquidityUsd,
                hasPairs: result.hasPairs,
                pairCount: result.pairCount,
              }, 'Token has liquidity but price fetch failed (possible API issue)');
            }
          }
        } catch (error) {
          logger.error({
            error: error instanceof Error ? error.message : String(error),
            failedAddresses,
          }, 'Failed to check liquidity for failed tokens');
        }
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const durationSeconds = duration / 1000;

      priceUpdateLatency.observe({ source: 'dexscreener' }, durationSeconds);
      priceUpdateCount.inc({ source: 'dexscreener', status: 'failed' });
      errorCount.inc({ type: 'prices', code: 'POLL_FAILED' });

      logger.error({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        duration,
      }, 'Error polling prices');
    } finally {
      // Always reset polling guard
      this.isPolling = false;
    }
  }

  /**
   * Process a price update
   * 
   * @param price - Token price to process
   * @param agentUpdates - Map to collect updates per agent for batching
   * @returns true if price was processed and should be broadcast, false if cached/untracked
   */
  private async processPriceUpdate(
    price: TokenPrice,
    agentUpdates: Map<string, Array<{ tokenAddress: string; price: number; priceUsd: number }>>
  ): Promise<boolean> {
    // Normalize token address to lowercase for consistent lookups
    const normalizedAddress = price.tokenAddress.toLowerCase();
    const tracking = this.trackedTokens.get(normalizedAddress);
    if (!tracking) {
      logger.warn({ tokenAddress: normalizedAddress }, 'Received price update for untracked token');
      return false; // Token no longer tracked
    }

    // Check local cache (use normalized address)
    const cached = this.priceCache.get(normalizedAddress);
    const now = new Date();

    if (cached) {
      const cacheAge = now.getTime() - cached.timestamp.getTime();
      // Only skip broadcast if price is cached AND price hasn't changed
      // This prevents duplicate broadcasts while still allowing price change updates
      if (cacheAge < this.CACHE_TTL &&
        cached.priceSol === price.priceSol &&
        cached.priceUsd === price.priceUsd) {
        // Price is cached and unchanged - don't broadcast
        return false;
      }
      // Price changed or cache expired - will broadcast below
    }

    // Update local cache
    const cachedPrice = {
      priceSol: price.priceSol,
      priceUsd: price.priceUsd,
      timestamp: now,
    };
    this.priceCache.set(normalizedAddress, cachedPrice);

    // Update Redis cache (async, don't wait)
    try {
      await redisPriceService.setPrice(normalizedAddress, {
        priceSol: price.priceSol,
        priceUsd: price.priceUsd,
        lastUpdated: now
      });
    } catch (err) {
      logger.error({
        tokenAddress: normalizedAddress,
        error: err instanceof Error ? err.message : String(err),
      }, 'Failed to cache price in Redis');
    }

    // Update tracking timestamp
    tracking.lastUpdate = now;

    // Price-only entries (SOL) have no agents: nothing to evaluate or broadcast,
    // the value is cached above for USD conversion and that is all it is for.
    if (tracking.agents.size === 0) {
      return false;
    }

    // NEW: Evaluate stop loss for all positions with this token
    await this.evaluateStopLossForToken(normalizedAddress, price.priceSol);

    // Collect updates for each agent (will be broadcast in batch later)
    for (const agentId of tracking.agents) {
      if (!agentUpdates.has(agentId)) {
        agentUpdates.set(agentId, []);
      }
      agentUpdates.get(agentId)!.push({
        tokenAddress: normalizedAddress,
        price: price.priceSol,
        priceUsd: price.priceUsd,
      });
    }

    return true; // Price was processed and added to batch
  }

  /**
   * Evaluate stop loss for all positions with a given token
   * 
   * @param tokenAddress - Token address (normalized to lowercase)
   * @param currentPrice - Current token price in SOL
   */
  private async evaluateStopLossForToken(
    tokenAddress: string,
    currentPrice: number
  ): Promise<void> {
    try {
      // Get all active positions for this token
      const positions = await positionService.getPositionsByToken(tokenAddress);

      if (positions.length === 0) {
        return; // No positions to evaluate
      }

      logger.debug({
        tokenAddress,
        positionCount: positions.length,
        currentPrice,
      }, 'Evaluating stop loss for positions');

      // Evaluate stop loss for each position
      for (const position of positions) {
        try {
          await this.evaluateStopLossForPosition(position, currentPrice);
        } catch (error) {
          // Log error but continue with other positions
          logger.error({
            positionId: position.id,
            tokenAddress,
            error: error instanceof Error ? error.message : String(error),
          }, 'Error evaluating stop loss for position');
        }
      }
    } catch (error) {
      // Log error but don't fail the price update
      logger.error({
        tokenAddress,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }, 'Error evaluating stop loss for token');
    }
  }

  /**
   * Evaluate stop loss for a single position and trigger sale if needed
   * Also evaluates stale trade auto-close if stop loss doesn't trigger.
   * 
   * @param position - Open position
   * @param currentPrice - Current token price in SOL
   */
  private async evaluateStopLossForPosition(
    position: OpenPosition,
    currentPrice: number
  ): Promise<void> {
    try {
      // Check if automated trading is enabled for agent's current mode (single Redis round trip)
      const automatedTrading = await redisAgentService.isAutomatedTradingEnabled(position.agentId);
      if (!automatedTrading) {
        // Skip ALL automated evaluations when paused:
        // - Stop loss
        // - Stale trade auto-close
        // - DCA
        // Price updates continue to flow (handled elsewhere)
        return;
      }

      // Load agent's trading config (once for both evaluations)
      const config = await configService.loadAgentConfig(position.agentId);

      // Evaluate stop loss if enabled
      if (config.stopLoss.enabled) {
        const evaluation = await stopLossManager.evaluateStopLoss(
          position,
          currentPrice,
          config
        );

        // Log evaluation result for debugging
        logger.debug({
          positionId: position.id,
          agentId: position.agentId,
          tokenAddress: position.tokenAddress,
          purchasePrice: position.purchasePrice,
          currentPrice,
          peakPrice: position.peakPrice,
          currentStopLossPercentage: position.currentStopLossPercentage,
          evaluationStopLossPercentage: evaluation.currentStopLossPercentage,
          stopLossPrice: evaluation.stopLossPrice,
          shouldTrigger: evaluation.shouldTrigger,
          stopLossEnabled: config.stopLoss.enabled,
        }, 'Stop loss evaluation result');

        // Check if stop loss should be triggered
        if (evaluation.shouldTrigger) {
          stopLossTriggerCount.inc({ agent_id: position.agentId, token_address: position.tokenAddress });

          logger.warn({
            positionId: position.id,
            agentId: position.agentId,
            tokenAddress: position.tokenAddress,
            currentPrice,
            stopLossPrice: evaluation.stopLossPrice,
            stopLossPercentage: evaluation.currentStopLossPercentage,
          }, 'Stop loss triggered');

          // Execute stop loss sale
          try {
            const saleStartTime = Date.now();
            const result = await tradingExecutor.executeSale({
              agentId: position.agentId,
              positionId: position.id,
              reason: 'stop_loss',
            });

            const saleDuration = Date.now() - saleStartTime;
            const saleDurationSeconds = saleDuration / 1000;

            stopLossEvaluationLatency.observe({ agent_id: position.agentId, token_address: position.tokenAddress }, saleDurationSeconds);

            logger.info({
              positionId: position.id,
              agentId: position.agentId,
              transactionId: result.transactionId,
              profitLossSol: result.profitLossSol,
              profitLossUsd: result.profitLossUsd,
              changePercent: result.changePercent,
              duration: saleDuration,
            }, 'Stop loss sale completed');
          } catch (error) {
            errorCount.inc({ type: 'stop_loss', code: 'SALE_FAILED' });

            // Import BalanceError dynamically to avoid circular dependency
            const { BalanceError } = await import('../balances/index.js');
            const isBalanceError = error instanceof BalanceError;

            const errorLog: Record<string, unknown> = {
              positionId: position.id,
              agentId: position.agentId,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            };

            // Add BalanceError-specific fields if available
            if (isBalanceError) {
              errorLog.currentBalance = error.currentBalance;
              errorLog.requiredAmount = error.requiredAmount;
              errorLog.tokenAddress = error.tokenAddress;
              errorLog.tokenSymbol = error.tokenSymbol;
              errorLog.positionPurchaseAmount = position.purchaseAmount;
              errorLog.positionTokenAddress = position.tokenAddress;
              errorLog.positionTokenSymbol = position.tokenSymbol;
            }

            logger.error(errorLog, 'Stop loss sale failed');
            // Re-throw to be caught by outer try-catch
            throw error;
          }

          // Exit early - position was closed by stop loss
          return;
        }
      }

      // Evaluate take-profit (only if stop loss didn't trigger)
      // Take-profit sells partially when price rises to configured levels
      const tpExecuted = await this.evaluateTakeProfitForPosition(position, currentPrice, config);

      if (tpExecuted) {
        // Take-profit executed - re-fetch position to get updated remaining amount
        // Continue with other evaluations as position may still be active
        position = await positionService.getPositionById(position.id) || position;
      }

      // Evaluate stale trade auto-close (only if stop loss didn't trigger)
      const staleClosed = await this.evaluateStaleTradeForPosition(position, currentPrice, config);

      if (staleClosed) {
        // Position was closed by stale trade, don't evaluate DCA
        return;
      }

      // Evaluate DCA (only if stop loss and stale trade didn't trigger closure)
      // DCA buys more when price drops, so it makes sense to check after sell triggers
      // DCA and take-profit can run concurrently (append-levels model)
      await this.evaluateDCAForPosition(position, currentPrice, config);

      // Update lowest price tracking for DCA analytics
      await positionService.updateLowestPrice(position.id, currentPrice);

    } catch (error) {
      // Log error but don't fail the price update
      logger.error({
        positionId: position.id,
        tokenAddress: position.tokenAddress,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }, 'Error in stop loss evaluation for position');
      throw error; // Re-throw to be caught by outer try-catch
    }
  }

  /**
   * Evaluate stale trade auto-close for a single position
   * 
   * Closes positions that have been held for a minimum time and have modest gains
   * that are unlikely to reach higher trailing stop levels.
   * 
   * @param position - Open position
   * @param currentPrice - Current token price in SOL
   * @param config - Agent's trading configuration
   * @returns true if stale trade close was triggered, false otherwise
   */
  private async evaluateStaleTradeForPosition(
    position: OpenPosition,
    currentPrice: number,
    config: AgentTradingConfig
  ): Promise<boolean> {
    // Check if stale trade auto-close is enabled
    if (!config.staleTrade?.enabled) {
      return false;
    }

    // Calculate position age in minutes
    const positionAgeMs = Date.now() - position.createdAt.getTime();
    const positionAgeMinutes = positionAgeMs / (1000 * 60);

    // Check minimum hold time
    if (positionAgeMinutes < config.staleTrade.minHoldTimeMinutes) {
      return false;
    }

    // Calculate profit percentage
    const profitPercent = ((currentPrice - position.purchasePrice) / position.purchasePrice) * 100;

    // Check if profit is within target range (stale trade zone)
    if (profitPercent >= config.staleTrade.minProfitPercent &&
      profitPercent <= config.staleTrade.maxProfitPercent) {

      staleTradeTriggerCount.inc({ agent_id: position.agentId, token_address: position.tokenAddress });

      logger.info({
        positionId: position.id,
        agentId: position.agentId,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        positionAgeMinutes: Math.round(positionAgeMinutes),
        profitPercent: profitPercent.toFixed(2),
        minHoldTime: config.staleTrade.minHoldTimeMinutes,
        targetRange: `${config.staleTrade.minProfitPercent}%-${config.staleTrade.maxProfitPercent}%`,
        purchasePrice: position.purchasePrice,
        currentPrice,
      }, 'Stale trade auto-close triggered');

      // Execute sale
      try {
        const saleStartTime = Date.now();
        const result = await tradingExecutor.executeSale({
          agentId: position.agentId,
          positionId: position.id,
          reason: 'stale_trade',
        });

        const saleDuration = Date.now() - saleStartTime;

        logger.info({
          positionId: position.id,
          agentId: position.agentId,
          transactionId: result.transactionId,
          profitLossSol: result.profitLossSol,
          profitLossUsd: result.profitLossUsd,
          changePercent: result.changePercent,
          duration: saleDuration,
        }, 'Stale trade sale completed');

        return true;
      } catch (error) {
        errorCount.inc({ type: 'stale_trade', code: 'SALE_FAILED' });

        logger.error({
          positionId: position.id,
          agentId: position.agentId,
          tokenAddress: position.tokenAddress,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }, 'Stale trade sale failed');

        throw error;
      }
    }

    return false;
  }

  /**
   * Evaluate take-profit for a single position and trigger partial sale if conditions are met
   * 
   * Take-profit sells a portion of the position when price rises to configured levels.
   * Multiple levels may be triggered if price jumped significantly.
   * 
   * DCA and take-profit can run concurrently (append-levels model).
   * 
   * @param position - Open position
   * @param currentPrice - Current token price in SOL
   * @param config - Agent's trading configuration
   * @returns true if take-profit was executed, false otherwise
   */
  private async evaluateTakeProfitForPosition(
    position: OpenPosition,
    currentPrice: number,
    config: AgentTradingConfig
  ): Promise<boolean> {
    // Check if take-profit is enabled
    if (!config.takeProfit?.enabled) {
      return false;
    }

    try {
      // Evaluate take-profit
      const evaluation = await takeProfitManager.evaluateTakeProfit(position, currentPrice, config);

      logger.debug({
        positionId: position.id,
        agentId: position.agentId,
        tokenSymbol: position.tokenSymbol,
        currentPrice,
        gainPercent: evaluation.gainPercent?.toFixed(2),
        levelsHit: position.takeProfitLevelsHit,
        shouldExecute: evaluation.shouldExecute,
        reason: evaluation.reason,
        levelsToExecute: evaluation.levelsToExecute.length,
        sellAmount: evaluation.sellAmount,
        activateMoonBag: evaluation.activateMoonBag,
      }, 'Take-profit evaluation result');

      if (evaluation.shouldExecute && evaluation.sellAmount > 0) {
        // Pre-check: Check if take-profit is already in progress
        // Note: Key format must match executeTakeProfitSale (hyphen, not underscore)
        const tpKey = `take-profit:${position.id}:${evaluation.levelsToExecute.length}`;
        const tpInProgress = await idempotencyService.isInProgress(tpKey);

        if (tpInProgress) {
          logger.debug({
            positionId: position.id,
            tokenSymbol: position.tokenSymbol,
          }, 'Take-profit skipped: already in progress');
          return false;
        }

        logger.info({
          positionId: position.id,
          agentId: position.agentId,
          tokenSymbol: position.tokenSymbol,
          gainPercent: evaluation.gainPercent?.toFixed(2),
          levelsToExecute: evaluation.levelsToExecute.map(l => l.targetPercent),
          sellAmount: evaluation.sellAmount,
          activateMoonBag: evaluation.activateMoonBag,
          moonBagAmount: evaluation.moonBagAmount,
        }, 'Take-profit triggered');

        try {
          const tpStartTime = Date.now();
          const result = await tradingExecutor.executeTakeProfitSale({
            agentId: position.agentId,
            positionId: position.id,
            sellAmount: evaluation.sellAmount,
            levelsExecuted: evaluation.levelsToExecute.length,
            activateMoonBag: evaluation.activateMoonBag,
            moonBagAmount: evaluation.moonBagAmount,
            newRemainingAmount: evaluation.newRemainingAmount,
          });

          const tpDuration = Date.now() - tpStartTime;

          logger.info({
            positionId: position.id,
            agentId: position.agentId,
            tokenSymbol: position.tokenSymbol,
            transactionId: result.transactionId,
            tokensSold: result.tokensSold,
            solReceived: result.solReceived,
            profitLossSol: result.profitLossSol,
            changePercent: result.changePercent?.toFixed(2),
            newRemainingAmount: result.newRemainingAmount,
            newLevelsHit: result.newLevelsHit,
            moonBagActivated: result.moonBagActivated,
            duration: tpDuration,
          }, 'Take-profit sale completed');

          return true;
        } catch (error) {
          errorCount.inc({ type: 'take_profit', code: 'SALE_FAILED' });

          logger.error({
            positionId: position.id,
            agentId: position.agentId,
            tokenSymbol: position.tokenSymbol,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }, 'Take-profit sale failed');

          // Don't re-throw - take-profit failure shouldn't stop price updates
          return false;
        }
      }

      return false;
    } catch (error) {
      // Log but don't throw - take-profit evaluation failure shouldn't stop price updates
      logger.error({
        positionId: position.id,
        tokenSymbol: position.tokenSymbol,
        error: error instanceof Error ? error.message : String(error),
      }, 'Take-profit evaluation error');
      return false;
    }
  }

  /**
   * Evaluate DCA for a single position and trigger buy if conditions are met
   * 
   * DCA is the inverse of stop loss - it buys more when price drops to configured levels,
   * lowering the average cost basis of the position.
   * 
   * @param position - Open position
   * @param currentPrice - Current token price in SOL
   * @param config - Agent's trading configuration
   */
  private async evaluateDCAForPosition(
    position: OpenPosition,
    currentPrice: number,
    config: AgentTradingConfig
  ): Promise<void> {
    // Check if DCA is enabled in config
    if (!config.dca?.enabled) {
      return;
    }

    try {
      // Re-fetch position from DB to ensure we have the latest dcaCount and purchasePrice
      // This prevents stale Redis cache from causing missed DCA triggers
      const freshPosition = await positionService.getPositionById(position.id);
      if (!freshPosition) {
        return; // Position was closed
      }

      // Use fresh position data for DCA evaluation
      const evalPosition = freshPosition;

      // Evaluate DCA
      const evaluation = await dcaManager.evaluateDCA(evalPosition, currentPrice, config);

      logger.debug({
        positionId: evalPosition.id,
        agentId: evalPosition.agentId,
        tokenAddress: evalPosition.tokenAddress,
        currentPrice,
        avgPrice: evalPosition.purchasePrice,
        dcaCount: evalPosition.dcaCount,
        shouldTrigger: evaluation.shouldTrigger,
        reason: evaluation.reason,
        triggerLevel: evaluation.triggerLevel,
        buyAmountSol: evaluation.buyAmountSol,
      }, 'DCA evaluation result');

      if (evaluation.shouldTrigger && evaluation.triggerLevel && evaluation.buyAmountSol) {
        // Pre-check 0: Enforce per-token auto-trade market-cap bounds for DCA actions.
        // DCA is gated by the same market-cap policy as re-entry/reconciliation so that
        // cost-averaging stops when a token moves outside the configured range.
        const normalizedTokenAddr = evalPosition.tokenAddress.trim().toLowerCase();
        const autoTradeTokenConfig = config.autoTrade?.tokens?.find(
          (t) => t.enabled && t.address.trim().toLowerCase() === normalizedTokenAddr
        );

        // Check in-memory cache first to avoid repeated external Jupiter API calls
        // when market-cap guard already rejected this token recently.
        const cachedExpiry = this.marketCapGuardRejectCache.get(normalizedTokenAddr);
        if (cachedExpiry && Date.now() < cachedExpiry) {
          logger.debug({
            positionId: evalPosition.id,
            tokenSymbol: evalPosition.tokenSymbol,
            dcaCount: evalPosition.dcaCount,
          }, 'DCA skipped: market-cap guard rejection cached');
          return;
        }

        const marketCapGuard = await evaluateAutoTradeMarketCapGuard({
          tokenAddress: evalPosition.tokenAddress,
          tokenBounds: autoTradeTokenConfig,
        });
        if (!marketCapGuard.allowed) {
          this.marketCapGuardRejectCache.set(
            normalizedTokenAddr,
            Date.now() + this.MARKET_CAP_GUARD_TTL_MS
          );

          logger.info({
            positionId: evalPosition.id,
            agentId: evalPosition.agentId,
            tokenAddress: evalPosition.tokenAddress,
            tokenSymbol: evalPosition.tokenSymbol,
            dcaCount: evalPosition.dcaCount,
            reason: marketCapGuard.reason,
            marketCap: marketCapGuard.marketCap,
            marketCapMin: autoTradeTokenConfig?.marketCapMin ?? null,
            marketCapMax: autoTradeTokenConfig?.marketCapMax ?? null,
          }, 'DCA skipped: auto-trade market-cap policy');
          return;
        }

        // Market cap is now in range — clear any cached rejection
        this.marketCapGuardRejectCache.delete(normalizedTokenAddr);

        // Pre-check 1: Check if DCA is suspended for this position (failed recently)
        // This prevents repeated Jupiter API calls when we know it will fail
        const dcaSuspendKey = `dca_suspend:${evalPosition.id}`;
        const dcaSuspended = await idempotencyService.isInProgress(dcaSuspendKey);

        if (dcaSuspended) {
          // DCA is suspended due to recent failure — log so operators can diagnose
          logger.info({
            positionId: evalPosition.id,
            tokenSymbol: evalPosition.tokenSymbol,
            dcaCount: evalPosition.dcaCount,
            triggerLevel: evaluation.triggerLevel,
          }, 'DCA skipped: suspended after recent failure (60s cooldown)');
          return;
        }

        // Pre-check 2: Check if DCA is already in progress for this position/level
        // Key includes dcaCount so each DCA attempt gets a unique idempotency key
        const dcaKey = `dca:${evalPosition.id}:${evalPosition.dcaCount}:${evaluation.triggerLevel.dropPercent}`;
        const dcaInProgress = await idempotencyService.isInProgress(dcaKey);

        if (dcaInProgress) {
          logger.debug({
            positionId: evalPosition.id,
            tokenAddress: evalPosition.tokenAddress,
          }, 'DCA skipped: already in progress');
          return; // Skip - DCA already executing for this position/level
        }

        // Pre-check 3: Check SOL balance before attempting DCA buy
        // This prevents unnecessary Jupiter API calls when balance is insufficient
        const solBalance = await redisBalanceService.getBalance(
          evalPosition.agentId,
          evalPosition.walletAddress,
          this.SOL_TOKEN_ADDRESS
        );
        let solBalanceNum = solBalance ? parseFloat(solBalance.balance) : 0;

        // Fallback: if Redis has no/zero SOL balance (e.g. sim deposit updated DB but cache missed, or Redis was flushed), load from DB and repopulate cache
        if (solBalanceNum <= 0) {
          const dbBalance = await prisma.agentBalance.findUnique({
            where: {
              walletAddress_tokenAddress: {
                walletAddress: evalPosition.walletAddress,
                tokenAddress: this.SOL_TOKEN_ADDRESS,
              },
            },
          });
          if (dbBalance) {
            const dbSol = parseFloat(dbBalance.balance.toString());
            if (dbSol > 0) {
              solBalanceNum = dbSol;
              await redisBalanceService.setBalance({
                id: dbBalance.id,
                agentId: dbBalance.agentId,
                walletAddress: dbBalance.walletAddress,
                tokenAddress: dbBalance.tokenAddress,
                tokenSymbol: dbBalance.tokenSymbol,
                balance: dbBalance.balance.toString(),
                lastUpdated: dbBalance.lastUpdated,
              });
              logger.debug({ positionId: evalPosition.id, walletAddress: evalPosition.walletAddress, solBalance: dbSol }, 'DCA: repopulated SOL balance from DB into cache');
            }
          }
        }

        if (solBalanceNum < evaluation.buyAmountSol) {
          logger.warn({
            positionId: evalPosition.id,
            tokenSymbol: evalPosition.tokenSymbol,
            tokenAddress: evalPosition.tokenAddress,
            availableBalance: solBalanceNum.toFixed(4),
            requiredAmount: evaluation.buyAmountSol.toFixed(4),
            dcaCount: evalPosition.dcaCount,
            triggerLevel: evaluation.triggerLevel,
          }, 'DCA skipped: insufficient SOL balance');
          return; // Skip DCA - insufficient balance
        }

        dcaTriggerCount.inc({
          agent_id: evalPosition.agentId,
          token_address: evalPosition.tokenAddress,
          level: evaluation.triggerLevel.dropPercent.toString(),
        });

        logger.info({
          positionId: evalPosition.id,
          tokenSymbol: evalPosition.tokenSymbol,
          dcaCount: evalPosition.dcaCount,
          dropPercent: evaluation.triggerLevel.dropPercent,
          buyAmountSol: evaluation.buyAmountSol.toFixed(4),
          availableBalance: solBalanceNum.toFixed(4),
        }, 'DCA attempting');

        try {
          const dcaStartTime = Date.now();
          const result = await tradingExecutor.executeDCABuy({
            agentId: evalPosition.agentId,
            positionId: evalPosition.id,
            buyAmountSol: evaluation.buyAmountSol,
            triggerLevel: evaluation.triggerLevel,
            dcaCount: evalPosition.dcaCount,
          });

          const dcaDuration = Date.now() - dcaStartTime;
          const dcaDurationSeconds = dcaDuration / 1000;

          dcaExecutionLatency.observe({
            agent_id: evalPosition.agentId,
            token_address: evalPosition.tokenAddress,
          }, dcaDurationSeconds);

          logger.info({
            tokenSymbol: evalPosition.tokenSymbol,
            solSpent: result.solSpent.toFixed(4),
            newDcaCount: result.newDcaCount,
            duration: dcaDuration,
          }, 'DCA completed');
        } catch (error) {
          errorCount.inc({ type: 'dca', code: 'BUY_FAILED' });

          // Log but don't throw - DCA failure shouldn't stop price updates
          const errorMessage = error instanceof Error ? error.message : String(error);
          const isInsufficientFunds = errorMessage.includes('Insufficient') ||
            errorMessage.includes('INSUFFICIENT_BALANCE');
          const isAlreadyInProgress = errorMessage.includes('already in progress');
          const isPositionLocked = errorMessage.includes('POSITION_LOCKED') ||
            errorMessage.includes('another operation is in progress');
          const isExpectedError = isInsufficientFunds || isAlreadyInProgress || isPositionLocked;

          if (isInsufficientFunds) {
            // Suspend DCA for this position for 60 seconds to avoid repeated API calls
            const dcaSuspendKey = `dca_suspend:${evalPosition.id}`;
            await idempotencyService.checkAndSet(dcaSuspendKey, 60); // 60 second cooldown
            logger.warn({
              positionId: evalPosition.id,
              tokenSymbol: evalPosition.tokenSymbol,
              dcaCount: evalPosition.dcaCount,
              suspendSeconds: 60,
            }, 'DCA suspended: insufficient funds');
          } else if (isPositionLocked) {
            // Position is locked by another operation - will retry next cycle
            logger.info({
              positionId: evalPosition.id,
              tokenSymbol: evalPosition.tokenSymbol,
              dcaCount: evalPosition.dcaCount,
            }, 'DCA deferred: position locked by another operation');
          } else if (isExpectedError) {
            // Other expected errors - log at info so operators can see
            logger.info({
              positionId: evalPosition.id,
              tokenSymbol: evalPosition.tokenSymbol,
              error: errorMessage,
            }, 'DCA skipped');
          } else {
            // Unexpected errors - log at error level
            logger.error({
              positionId: evalPosition.id,
              tokenSymbol: evalPosition.tokenSymbol,
              dcaCount: evalPosition.dcaCount,
              error: errorMessage,
            }, 'DCA failed');
          }
        }
      }
    } catch (error) {
      // Log but don't throw - DCA evaluation failure shouldn't stop price updates
      logger.error({
        positionId: position.id,
        tokenSymbol: position.tokenSymbol,
        error: error instanceof Error ? error.message : String(error),
      }, 'DCA evaluation error');
    }
  }

  /**
   * Get cached price for a token
   */
  getCachedPrice(tokenAddress: string): CachedPrice | null {
    return this.priceCache.get(tokenAddress) || null;
  }

  /**
   * Get list of tracked tokens
   */
  getTrackedTokens(): string[] {
    return Array.from(this.trackedTokens.keys());
  }

  /**
   * Get tracking info for a token
   */
  getTokenTracking(tokenAddress: string): TokenTracking | null {
    return this.trackedTokens.get(tokenAddress) || null;
  }

  /**
   * Stop price polling
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.currentPollIntervalMs = null;
      logger.info('Price polling stopped');
    }
  }

  /**
   * Shutdown price update manager
   */
  shutdown(): void {
    this.stopPolling();
    this.trackedTokens.clear();
    this.priceCache.clear();
    this.wsServer = null;
    logger.info('Price update manager shut down');
  }
}

// Export singleton instance
export const priceUpdateManager = new PriceUpdateManager();
