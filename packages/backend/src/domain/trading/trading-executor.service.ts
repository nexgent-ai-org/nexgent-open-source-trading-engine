/**
 * Trading Executor Service
 * 
 * Orchestrates complete trade execution flow, integrating all services:
 * - TradeValidator: Pre-trade validation
 * - PositionCalculator: Position sizing
 * - PriceFeedService: Token price fetching
 * - SwapService: Swap execution (quote + execute)
 * - BalanceService: Balance updates
 * - PositionService: Position tracking
 * - StopLossManager: Stop loss initialization
 * - CacheService: Cache invalidation
 */

import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/database/client.js';
import { tradeValidator, TradeValidatorError } from './trade-validator.service.js';
import { priceFeedService } from '@/infrastructure/external/dexscreener/index.js';
import { swapService, SOL_MINT_ADDRESS } from '@/infrastructure/external/jupiter/index.js';
import { balanceService, BalanceError } from '../balances/index.js';
import { positionService } from './position-service.js';
import { stopLossManager } from './stop-loss-manager.service.js';
import { dcaManager } from './dca-manager.service.js';
import { configService } from './config-service.js';
import { redisBalanceService } from '@/infrastructure/cache/redis-balance-service.js';
import { redisPositionService } from '@/infrastructure/cache/redis-position-service.js';
import { idempotencyService } from '@/infrastructure/cache/idempotency-service.js';
import { redisService } from '@/infrastructure/cache/redis-client.js';
import { REDIS_KEYS, REDIS_TTL } from '@/shared/constants/redis-keys.js';
import { tokenMetadataService } from '@/infrastructure/external/solana/token-metadata-service.js';
import { SolPriceService } from '@/infrastructure/external/jupiter/price/sol-price-service.js';
import { positionEventEmitter } from './position-events.js';
import { extractJupiterFees } from './jupiter-fee-calculator.js';
import type { OpenPosition } from '@nexgent/shared';
import type { IAgentRepository } from '../agents/agent.repository.js';
import type { IPositionRepository } from '../positions/position.repository.js';
import type { ITransactionRepository } from '../transactions/transaction.repository.js';
import { AgentRepository } from '@/infrastructure/database/repositories/agent.repository.js';
import { PositionRepository } from '@/infrastructure/database/repositories/position.repository.js';
import { TransactionRepository } from '@/infrastructure/database/repositories/transaction.repository.js';
import { queueClient } from '@/infrastructure/queue/queue-client.js';
import { QueueName, JobType } from '@/infrastructure/queue/job-types.js';
import { randomUUID } from 'crypto';
import { withTimeout, API_TIMEOUTS } from '@/shared/utils/timeout.js';
import { tradeExecutionLatency, tradeExecutionCount, errorCount } from '@/infrastructure/metrics/metrics.js';
import logger from '@/infrastructure/logging/logger.js';

/**
 * Trading Executor Error
 */
export class TradingExecutorError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'TradingExecutorError';
  }
}

/**
 * Get a numeric field from swapPayload. Supports both legacy flat payload and full payload
 * shape { orderResponse, executeResponse } from Jupiter.
 */
function getSwapPayloadNumber(
  payload: Record<string, unknown> | null | undefined,
  key: string
): number | undefined {
  if (!payload) return undefined;
  if (typeof (payload as Record<string, unknown>)[key] === 'number') return (payload as Record<string, unknown>)[key] as number;
  const exec = payload.executeResponse as Record<string, unknown> | undefined;
  const order = payload.orderResponse as Record<string, unknown> | undefined;
  if (exec && typeof exec[key] === 'number') return exec[key] as number;
  if (order && typeof order[key] === 'number') return order[key] as number;
  return undefined;
}

/**
 * Trade execution request
 */
export interface TradeExecutionRequest {
  agentId: string;
  walletAddress?: string;   // Optional: uses default wallet for agent's trading mode if not provided
  tokenAddress: string;
  tokenSymbol?: string;     // Optional: will be fetched if not provided
  signalId?: number;        // Optional: link to trading signal
  positionSize?: number;    // Optional: override calculated position size
}

/**
 * Trade execution result
 */
export interface TradeExecutionResult {
  success: true;
  transactionId: string;
  positionId: string | null;
  inputAmount: number;      // SOL spent
  outputAmount: number;     // Tokens received
  purchasePrice: number;    // SOL per token
  transactionHash: string | null;  // On-chain transaction hash (null for simulation)
  stopLossInitialized: boolean;
  stopLossPercentage?: number;  // Initial stop loss %
  signalId?: number;
}

/**
 * Sale execution request
 */
export interface SaleExecutionRequest {
  agentId: string;
  positionId: string;  // Position to close
  walletAddress?: string;   // Optional: uses default wallet if not provided
  reason?: 'manual' | 'stop_loss' | 'stale_trade' | 'take_profit';  // Optional: reason for closure
}

/**
 * Sale execution result
 */
export interface SaleExecutionResult {
  success: true;
  transactionId: string;        // Sale transaction ID
  historicalSwapId: string;     // Historical swap record ID
  positionId: string;            // Closed position ID
  inputAmount: number;           // Token amount sold
  outputAmount: number;          // SOL received
  salePrice: number;            // SOL per token
  profitLossSol: number;        // Profit/loss in SOL
  profitLossUsd: number;        // Profit/loss in USD
  changePercent: number;         // Percentage change
  transactionHash: string | null; // On-chain transaction hash (null for simulation)
}

/**
 * DCA buy execution request
 */
export interface DCABuyRequest {
  agentId: string;
  positionId: string;           // Position to DCA into
  buyAmountSol: number;         // Amount of SOL to spend
  triggerLevel: {               // The DCA level that triggered this buy
    dropPercent: number;
    buyPercent: number;
  };
  /** Current DCA count at time of evaluation (used for unique idempotency keys) */
  dcaCount: number;
}

/**
 * DCA buy execution result
 */
export interface DCABuyResult {
  success: true;
  transactionId: string;        // DCA transaction ID
  positionId: string;           // Position ID
  tokensAcquired: number;       // Tokens bought in this DCA
  solSpent: number;             // SOL spent in this DCA
  newAveragePrice: number;      // New weighted average purchase price
  newTotalAmount: number;       // New total token amount
  newDcaCount: number;          // Updated DCA count
  transactionHash: string | null; // On-chain transaction hash (null for simulation)
}

/**
 * Take-profit sale execution request
 */
export interface TakeProfitSaleRequest {
  agentId: string;
  positionId: string;             // Position to partially sell
  sellAmount: number;             // Amount of tokens to sell
  levelsExecuted: number;         // Number of TP levels being executed
  activateMoonBag: boolean;       // Whether to activate moon bag
  moonBagAmount?: number;         // Moon bag amount (if activating)
  newRemainingAmount: number;     // New remaining amount after sale
}

/**
 * Take-profit sale execution result
 */
export interface TakeProfitSaleResult {
  success: true;
  transactionId: string;          // Sale transaction ID
  positionId: string;             // Position ID (closed if positionClosed is true)
  tokensSold: number;             // Tokens sold in this take-profit
  solReceived: number;            // SOL received from sale
  salePrice: number;              // SOL per token
  profitLossSol: number;          // Profit/loss for this partial sale in SOL
  profitLossUsd: number;          // Profit/loss for this partial sale in USD
  changePercent: number;          // Percentage change from purchase
  newRemainingAmount: number;     // Remaining tokens after sale
  newLevelsHit: number;           // Total TP levels hit after this sale
  moonBagActivated: boolean;      // Whether moon bag was activated
  transactionHash: string | null; // On-chain transaction hash (null for simulation)
  /** True when position was fully sold (no moonbag) and closed */
  positionClosed?: boolean;
  /** Historical swap ID when position was closed via take-profit */
  historicalSwapId?: string;
}

/**
 * Trading Executor Service
 * 
 * Singleton service for executing trades.
 */
/** Dust threshold for remaining token amount - below this we consider position fully sold */
const TAKE_PROFIT_DUST_THRESHOLD = 1e-9;

class TradingExecutor {
  /** SOL token mint address */
  private readonly SOL_TOKEN_ADDRESS = SOL_MINT_ADDRESS;

  /**
   * TTL for per-position distributed locks (seconds).
   * Must be longer than the longest expected execution path (swap + DB transaction).
   * 60s gives ample headroom; the lock is released explicitly on completion.
   */
  private readonly POSITION_LOCK_TTL = 60;

  constructor(
    private readonly agentRepo: IAgentRepository,
    private readonly positionRepo: IPositionRepository,
    private readonly transactionRepo: ITransactionRepository
  ) { }

  /**
   * Execute a function while holding a per-position distributed lock.
   *
   * Ensures only one operation (sale, DCA buy, take-profit) can run against
   * a given position at any time, preventing race conditions between
   * concurrent stop-loss, take-profit, DCA, and manual sale triggers.
   *
   * @param positionId - Position to lock
   * @param operationName - Human-readable name for logging (e.g. 'sale', 'dca', 'take-profit')
   * @param fn - The function to execute while holding the lock
   * @returns The return value of fn
   * @throws TradingExecutorError if the lock cannot be acquired
   */
  private async withPositionLock<T>(
    positionId: string,
    operationName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockKey = REDIS_KEYS.LOCK(`position:${positionId}`);
    const lockToken = await redisService.acquireLock(lockKey, this.POSITION_LOCK_TTL);

    if (!lockToken) {
      throw new TradingExecutorError(
        `Cannot acquire lock for position — another operation is in progress`,
        'POSITION_LOCKED',
        { positionId, operation: operationName }
      );
    }

    try {
      return await fn();
    } finally {
      await redisService.releaseLock(lockKey, lockToken);
    }
  }

  /**
   * Execute a purchase (buy) trade
   * 
   * Complete flow:
   * 1. Validate trade execution (agent, wallet, balance, etc.)
   * 2. Get token price from price feed
   * 3. Get swap quote from swap service
   * 4. Execute swap (or use quote for simulation)
   * 5. Create transaction record and update balances atomically
   * 6. Initialize position and stop loss if enabled
   * 7. Invalidate caches
   * 
   * @param request - Trade execution request
   * @returns Trade execution result
   * @throws TradingExecutorError if execution fails at any step
   */
  async executePurchase(request: TradeExecutionRequest): Promise<TradeExecutionResult> {
    const startTime = Date.now();
    try {
      // Step 0: Get wallet address (use default if not provided)
      const walletAddress = request.walletAddress || await this.getDefaultWalletAddress(request.agentId);
      if (!walletAddress) {
        throw new TradingExecutorError(
          'No wallet found for agent',
          'WALLET_NOT_FOUND',
          { agentId: request.agentId }
        );
      }

      // Step 1: Validate trade execution
      // This validates agent, wallet, balance, position, and calculates position size if not provided
      const validation = await tradeValidator.validateTradeExecution(
        request.agentId,
        walletAddress,
        request.tokenAddress,
        request.positionSize
      );

      if (!validation.valid || !validation.config || !validation.currentSolBalance || !validation.positionSize) {
        throw new TradingExecutorError(
          validation.error || 'Trade validation failed',
          validation.errorCode || 'VALIDATION_FAILED'
        );
      }

      const config = validation.config;
      const positionSize = validation.positionSize;

      // Step 2: Get wallet (needed for swap execution)
      const wallet = await this.agentRepo.findWalletByAddress(walletAddress);

      if (!wallet) {
        throw new TradingExecutorError(
          `Wallet not found: ${walletAddress}`,
          'WALLET_NOT_FOUND'
        );
      }

      const isSimulation = wallet.walletType === 'simulation';

      // Step 3 & 4: Parallelize independent operations
      // - Get token price (for symbol extraction if needed)
      // - Get token decimals (needed for swap)
      // - Get swap quote (independent of price/decimals)
      const positionSizeLamports = Math.floor(positionSize * 1e9);

      // Parallelize: Get token metadata (decimals) + Get swap quote
      // These are independent and can be done simultaneously
      // Add timeouts to prevent hanging on slow external APIs
      const [tokenDecimals, swapQuote] = await Promise.all([
        withTimeout(
          tokenMetadataService.getTokenDecimals(request.tokenAddress),
          API_TIMEOUTS.TOKEN_METADATA,
          `Token metadata fetch timed out for ${request.tokenAddress}`
        ),
        withTimeout(
          swapService.getQuote({
            inputMint: this.SOL_TOKEN_ADDRESS,
            outputMint: request.tokenAddress,
            amount: positionSizeLamports,
            walletAddress: isSimulation ? undefined : wallet.walletAddress, // Jupiter rejects simulation wallet as taker; live needs taker for fees + tx
          }),
          API_TIMEOUTS.JUPITER_QUOTE,
          `Jupiter quote request timed out for ${request.tokenAddress}`
        ),
      ]);

      // Get token symbol if not provided (use placeholder for now, can be extracted from swap response later)
      const tokenSymbol = request.tokenSymbol || 'TOKEN';

      // Step 4.5: Check price impact and retry with reduced amounts if needed
      let finalQuote = swapQuote;
      const maxRetries = 3;
      const retryMultipliers = [0.9, 0.8, 0.7]; // 90%, 80%, 70%
      const MINIMUM_VIABLE_PURCHASE = 0.01; // Minimum SOL amount for retry
      const RETRY_DELAY_MS = 5000; // Delay between price-impact retries to allow liquidity to settle

      // Check price impact (slippage) if threshold is set
      // Note: Jupiter returns price impact as negative (e.g., -5% means 5% slippage)
      // We use absolute value to compare against threshold
      if (config.purchaseLimits.maxPriceImpact !== undefined &&
        config.purchaseLimits.maxPriceImpact !== null) {
        const maxPriceImpact = config.purchaseLimits.maxPriceImpact;

        // Price impact from Jupiter is negative (slippage), so use absolute value
        const priceImpactAbs = Math.abs(swapQuote.priceImpact);

        // Check initial quote - reject if absolute price impact (slippage) exceeds threshold
        if (priceImpactAbs >= maxPriceImpact) {
          logger.info({
            agentId: request.agentId,
            tokenAddress: request.tokenAddress,
            initialPriceImpact: swapQuote.priceImpact,
            priceImpactAbs,
            threshold: maxPriceImpact,
            initialAmount: positionSize,
          }, 'Price impact (slippage) exceeds threshold, attempting retry with reduced amount');

          // Retry with reduced amounts (with delay between retries to allow liquidity to settle)
          let retrySuccessful = false;
          for (let i = 0; i < maxRetries; i++) {
            if (i > 0) {
              await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            }
            const retryMultiplier = retryMultipliers[i];
            const retryAmount = positionSize * retryMultiplier;
            const retryAmountLamports = Math.floor(retryAmount * 1e9);

            // Minimum viable purchase amount
            if (retryAmount < MINIMUM_VIABLE_PURCHASE) {
              logger.warn({
                agentId: request.agentId,
                tokenAddress: request.tokenAddress,
                retryAmount,
              }, 'Retry amount below minimum, stopping retries');
              break;
            }

            // Get new quote with reduced amount
            const retryQuote = await withTimeout(
              swapService.getQuote({
                inputMint: this.SOL_TOKEN_ADDRESS,
                outputMint: request.tokenAddress,
                amount: retryAmountLamports,
                walletAddress: isSimulation ? undefined : wallet.walletAddress,
              }),
              API_TIMEOUTS.JUPITER_QUOTE,
              `Jupiter quote retry ${i + 1} timed out for ${request.tokenAddress}`
            );

            const retryPriceImpactAbs = Math.abs(retryQuote.priceImpact);
            logger.info({
              agentId: request.agentId,
              tokenAddress: request.tokenAddress,
              retryAttempt: i + 1,
              retryAmount,
              priceImpact: retryQuote.priceImpact,
              priceImpactAbs: retryPriceImpactAbs,
              threshold: maxPriceImpact,
            }, `Price impact (slippage) retry attempt ${i + 1}`);

            // Check if retry quote meets threshold
            // Accept if absolute price impact (slippage) is below threshold
            if (retryPriceImpactAbs < maxPriceImpact) {
              finalQuote = retryQuote;
              retrySuccessful = true;
              logger.info({
                agentId: request.agentId,
                tokenAddress: request.tokenAddress,
                finalAmount: retryAmount,
                finalPriceImpact: retryQuote.priceImpact,
              }, 'Price impact retry successful');
              break;
            }
          }

          // If all retries failed, reject the trade
          if (!retrySuccessful) {
            const initialPriceImpactAbs = Math.abs(swapQuote.priceImpact);
            throw new TradingExecutorError(
              `Price impact (slippage) ${(initialPriceImpactAbs * 100).toFixed(2)}% exceeds maximum threshold ${(maxPriceImpact * 100).toFixed(2)}% even after retries`,
              'PRICE_IMPACT_TOO_HIGH',
              {
                initialPriceImpact: swapQuote.priceImpact,
                initialPriceImpactAbs,
                threshold: maxPriceImpact,
                initialAmount: positionSize,
              }
            );
          }
        }
      }

      // Step 5: Execute swap (or use quote for simulation)
      // For live mode, JupiterSwapProvider retrieves keypair from walletStore
      // For simulation, no keypair needed - returns mock data from quote
      const swapResult = await withTimeout(
        swapService.executeSwap({
          quote: finalQuote,
          walletAddress: wallet.walletAddress,
          isSimulation,
        }),
        API_TIMEOUTS.JUPITER_EXECUTE,
        `Swap execution timed out for ${request.tokenAddress}`
      );

      // Step 5.5: Convert amounts (tokenDecimals already fetched in parallel above)
      // Jupiter returns amounts in smallest units (lamports for SOL, token's smallest unit for tokens)
      const solDecimals = 9; // SOL always has 9 decimals

      // Use Decimal for precise calculations to avoid floating-point precision loss
      // This is critical for very small token prices (e.g., 6.632e-11 SOL per token)
      const inputAmountDecimal = new Decimal(swapResult.inputAmount).div(Math.pow(10, solDecimals));
      const outputAmountDecimal = new Decimal(swapResult.outputAmount).div(Math.pow(10, tokenDecimals));

      // Total SOL debited (when Jupiter returns it): includes swap + fees + rent. Use for display and balance.
      const totalInputAmountSol = swapResult.totalInputAmount != null
        ? new Decimal(swapResult.totalInputAmount).div(Math.pow(10, solDecimals)).toNumber()
        : inputAmountDecimal.toNumber();

      // Calculate actual purchase price (SOL per token) from swap amount only (excludes fees)
      const calculatedPurchasePriceDecimal = inputAmountDecimal.div(outputAmountDecimal);

      // Convert to numbers for backward compatibility (but use Decimal for DB storage)
      const inputAmountSol = inputAmountDecimal.toNumber();
      const outputAmountTokens = outputAmountDecimal.toNumber();
      const calculatedPurchasePrice = calculatedPurchasePriceDecimal.toNumber();

      // Get transaction value in USD - use total SOL debited when available so value matches wallet
      let transactionValueUsd: number;
      const solPrice = await SolPriceService.getInstance().getSolPriceOrFetch();
      const swapUsdValue = getSwapPayloadNumber(swapResult.swapPayload as Record<string, unknown> | null, 'swapUsdValue');
      if (typeof swapUsdValue === 'number') {
        transactionValueUsd = swapUsdValue;
      } else {
        transactionValueUsd = totalInputAmountSol * solPrice;
      }

      // Note: Token symbol comes from request.tokenSymbol (set in signal)
      // Jupiter works with mint addresses, not symbols

      // Step 5.6: Extract fees from Jupiter payload
      const { protocolFeeSol, networkFeeSol } = extractJupiterFees(swapResult.swapPayload);
      // Total SOL to debit from balance: totalInputAmount includes protocol fee; add network fee
      const balanceDebitSol = totalInputAmountSol + (networkFeeSol ?? 0);

      // Step 6: Create transaction record, update balances, and create position atomically
      // All within a single DB transaction (write-through pattern):
      // 1. Create transaction record in DB
      // 2. Update balances in DB
      // 3. Create position in DB (if stop loss enabled)
      // 4. After transaction commits: Update Redis cache
      // 5. Initialize stop loss (updates position via write-through)

      const transactionId = randomUUID();
      const now = new Date();

      // Prepare transaction data for DB Queue
      const transactionData = {
        id: transactionId,
        agent: { connect: { id: request.agentId } },
        wallet: { connect: { walletAddress: walletAddress } },
        transactionType: 'SWAP' as const,
        transactionValueUsd: new Decimal(transactionValueUsd),
        transactionTime: now,
        signal: request.signalId ? { connect: { id: request.signalId } } : undefined,
        fees: new Decimal(swapResult.fees || 0),
        routes: swapResult.routes ? (swapResult.routes as Prisma.InputJsonValue) : Prisma.JsonNull,
        swapPayload: swapResult.swapPayload ? (swapResult.swapPayload as Prisma.InputJsonValue) : Prisma.JsonNull,
        inputMint: this.SOL_TOKEN_ADDRESS,
        inputSymbol: 'SOL',
        inputAmount: new Decimal(inputAmountSol), // Raw swap amount (fees stored separately in protocolFeeSol/networkFeeSol)
        inputPrice: new Decimal(1.0), // SOL is base currency
        outputMint: request.tokenAddress,
        outputSymbol: tokenSymbol,
        outputAmount: new Decimal(outputAmountTokens), // Already converted from smallest unit to tokens
        outputPrice: new Decimal(calculatedPurchasePrice),
        slippage: swapResult.slippage ? new Decimal(swapResult.slippage) : null,
        priceImpact: swapResult.priceImpact ? new Decimal(swapResult.priceImpact) : null,
        transactionHash: swapResult.transactionHash ?? null,
        protocolFeeSol: protocolFeeSol != null ? new Decimal(protocolFeeSol) : null,
        networkFeeSol: networkFeeSol != null ? new Decimal(networkFeeSol) : null,
      };

      // Step 6: Create transaction, update balances, and create position atomically
      let dbTransaction: Awaited<ReturnType<typeof this.transactionRepo.create>>;
      let positionId: string | null = null;
      let stopLossPercentage: number | undefined;
      let stopLossInitialized = false;

      // Wrap everything in a DB transaction for atomicity
      // Use 15s timeout to accommodate multiple DB operations and potential network latency
      await prisma.$transaction(async (tx) => {
        // Create transaction record
        dbTransaction = await this.transactionRepo.create(transactionData, tx);

        // Update balances (within transaction)
        // balanceDebitSol = totalInputAmount (includes protocol fee) + networkFeeSol
        await balanceService.updateBalancesFromTransaction(
          walletAddress,
          request.agentId,
          'SWAP',
          this.SOL_TOKEN_ADDRESS,
          'SOL',
          new Decimal(balanceDebitSol), // Total SOL debited (protocol + network fees)
          request.tokenAddress,
          tokenSymbol,
          new Decimal(outputAmountTokens), // Token amount (already converted)
          tx // Pass transaction context
        );

        // Step 7: Initialize position if stop-loss OR take-profit is enabled (within transaction)
        // Position tracking is required for either feature to work
        if (config.stopLoss.enabled || config.takeProfit?.enabled) {
          // Validate required fields are not null
          // Check the Decimal value for precision, but also check the number for backward compatibility
          if (!outputAmountTokens || calculatedPurchasePriceDecimal.isZero() || !isFinite(calculatedPurchasePrice)) {
            throw new TradingExecutorError(
              'Transaction missing required fields for position creation',
              'INVALID_TRANSACTION',
              { transactionId: dbTransaction.id }
            );
          }

          // Use Decimal values converted to strings to preserve precision for very small numbers
          // This prevents precision loss when storing values like 6.632e-11 SOL per token
          const tokenAmount = outputAmountTokens;
          // Convert Decimal to string to preserve full precision, then parse back to number
          // This ensures we don't lose precision from floating-point arithmetic
          const purchasePriceStr = calculatedPurchasePriceDecimal.toFixed(18);
          const purchasePrice = parseFloat(purchasePriceStr);

          // Create position (within transaction)
          const position = await positionService.createPosition(
            request.agentId,
            walletAddress,
            dbTransaction.id,
            request.tokenAddress,
            tokenSymbol,
            purchasePrice,
            tokenAmount,
            tx, // Pass transaction context
            balanceDebitSol // Total SOL debited (protocol + network fees)
          );

          positionId = position.id;
        }
      }, { timeout: 15000 });

      // After transaction commits: Update Redis cache for balances and position
      // Fetch updated balances from DB (they were updated within the transaction)
      const inputBalance = await prisma.agentBalance.findUnique({
        where: {
          walletAddress_tokenAddress: {
            walletAddress,
            tokenAddress: this.SOL_TOKEN_ADDRESS,
          },
        },
      });

      const outputBalance = await prisma.agentBalance.findUnique({
        where: {
          walletAddress_tokenAddress: {
            walletAddress,
            tokenAddress: request.tokenAddress,
          },
        },
      });

      // Update Redis cache for balances
      if (inputBalance) {
        await redisBalanceService.setBalance({
          id: inputBalance.id,
          agentId: inputBalance.agentId,
          walletAddress: inputBalance.walletAddress,
          tokenAddress: inputBalance.tokenAddress,
          tokenSymbol: inputBalance.tokenSymbol,
          balance: inputBalance.balance,
          lastUpdated: inputBalance.lastUpdated,
        });
      }

      if (outputBalance) {
        await redisBalanceService.setBalance({
          id: outputBalance.id,
          agentId: outputBalance.agentId,
          walletAddress: outputBalance.walletAddress,
          tokenAddress: outputBalance.tokenAddress,
          tokenSymbol: outputBalance.tokenSymbol,
          balance: outputBalance.balance,
          lastUpdated: outputBalance.lastUpdated,
        });
      }

      // Update Redis cache for position if created
      if (positionId) {
        const dbPosition = await prisma.agentPosition.findUnique({
          where: { id: positionId },
        });

        if (dbPosition) {
          await redisPositionService.setPosition(dbPosition);

          // Initialize stop loss (this method updates the position internally)
          stopLossPercentage = await stopLossManager.initializeStopLoss(
            positionId,
            calculatedPurchasePrice,
            config
          );

          stopLossInitialized = true;

          // Emit position_created after commit and Redis update so price-update-manager
          // and getPositionsByToken see the position immediately (fixes DCA only working after restart).
          const openPosition = await positionService.getPositionById(positionId);
          if (openPosition) {
            positionEventEmitter.emitPositionCreated({
              agentId: request.agentId,
              walletAddress,
              position: openPosition,
            });
          }
        }
      }

      const transaction = {
        id: transactionId,
        agentId: request.agentId,
        walletAddress: walletAddress,
        outputSymbol: tokenSymbol,
        outputAmount: new Decimal(outputAmountTokens),
        outputPrice: new Decimal(calculatedPurchasePrice),
        transactionHash: swapResult.transactionHash || null,
      };

      // Record metrics and log
      const duration = Date.now() - startTime;
      const durationSeconds = duration / 1000;

      tradeExecutionLatency.observe({ type: 'purchase', status: 'success' }, durationSeconds);
      tradeExecutionCount.inc({ type: 'purchase', status: 'success' });

      logger.info({
        agentId: request.agentId,
        tokenAddress: request.tokenAddress,
        tokenSymbol,
        transactionId: transaction.id,
        positionId,
        inputAmount: totalInputAmountSol,
        outputAmount: outputAmountTokens,
        duration,
      }, 'Purchase executed successfully');

      // Return success result
      return {
        success: true,
        transactionId: transaction.id,
        positionId,
        inputAmount: totalInputAmountSol, // Total SOL debited (includes fees when Jupiter provides totalInputAmount)
        outputAmount: outputAmountTokens, // Token amount (already converted)
        purchasePrice: transaction.outputPrice?.toNumber() || calculatedPurchasePrice,
        transactionHash: transaction.transactionHash,
        stopLossInitialized,
        stopLossPercentage,
        signalId: request.signalId,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const durationSeconds = duration / 1000;

      // Record metrics
      tradeExecutionLatency.observe({ type: 'purchase', status: 'failed' }, durationSeconds);
      tradeExecutionCount.inc({ type: 'purchase', status: 'failed' });

      // Handle TradeValidatorError (convert to TradingExecutorError)
      if (error instanceof TradeValidatorError) {
        const tradingError = new TradingExecutorError(
          error.message,
          error.code || 'VALIDATION_FAILED',
          error.details
        );

        // Downgrade insufficient balance errors to warnings (expected business logic)
        const isInsufficientBalance = tradingError.code === 'INSUFFICIENT_BALANCE' ||
          tradingError.message.includes('Insufficient SOL balance') ||
          tradingError.message.includes('Insufficient balance');

        if (isInsufficientBalance) {
          logger.warn({
            agentId: request.agentId,
            tokenAddress: request.tokenAddress,
            walletAddress: request.walletAddress,
            error: tradingError.message,
            code: tradingError.code,
            duration,
          }, 'Purchase skipped: insufficient balance');
        } else {
          logger.error({
            agentId: request.agentId,
            tokenAddress: request.tokenAddress,
            walletAddress: request.walletAddress,
            error: tradingError.message,
            code: tradingError.code,
            duration,
          }, 'Purchase failed');
        }

        errorCount.inc({ type: 'trading', code: tradingError.code || 'VALIDATION_FAILED' });
        throw tradingError;
      }

      // Handle balance update failures (e.g. wallet reset removed SOL balance row)
      // as expected insufficient-balance outcomes so automation can skip gracefully.
      if (typeof BalanceError === 'function' && error instanceof BalanceError) {
        const isMissingBalance = error.message.includes('Balance not found');
        const tradingError = new TradingExecutorError(
          isMissingBalance
            ? 'Insufficient SOL balance: balance record missing (wallet may have been reset)'
            : error.message,
          'INSUFFICIENT_BALANCE',
          {
            currentBalance: error.currentBalance,
            requiredAmount: error.requiredAmount,
            tokenAddress: error.tokenAddress,
            tokenSymbol: error.tokenSymbol,
            isMissingBalance,
          }
        );

        logger.warn({
          agentId: request.agentId,
          tokenAddress: request.tokenAddress,
          walletAddress: request.walletAddress,
          error: tradingError.message,
          code: tradingError.code,
          duration,
        }, 'Purchase skipped: insufficient balance state');

        errorCount.inc({ type: 'trading', code: tradingError.code || 'INSUFFICIENT_BALANCE' });
        throw tradingError;
      }

      // Handle TradingExecutorError
      if (error instanceof TradingExecutorError) {
        // Downgrade insufficient balance errors to warnings (expected business logic)
        const isInsufficientBalance = error.code === 'INSUFFICIENT_BALANCE' ||
          error.message.includes('Insufficient SOL balance') ||
          error.message.includes('Insufficient balance');

        if (isInsufficientBalance) {
          logger.warn({
            agentId: request.agentId,
            tokenAddress: request.tokenAddress,
            walletAddress: request.walletAddress,
            error: error.message,
            code: error.code,
            duration,
          }, 'Purchase skipped: insufficient balance');
        } else {
          logger.error({
            agentId: request.agentId,
            tokenAddress: request.tokenAddress,
            walletAddress: request.walletAddress,
            error: error.message,
            code: error.code,
            duration,
          }, 'Purchase failed');
        }

        errorCount.inc({ type: 'trading', code: error.code || 'EXECUTION_FAILED' });
        throw error;
      }

      // Wrap unexpected errors with better context
      logger.error({
        agentId: request.agentId,
        tokenAddress: request.tokenAddress,
        walletAddress: request.walletAddress,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        duration,
      }, 'Purchase failed with unexpected error');

      errorCount.inc({ type: 'trading', code: 'EXECUTION_FAILED' });

      throw new TradingExecutorError(
        `Trade execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EXECUTION_FAILED',
        {
          originalError: error instanceof Error ? error.message : String(error),
          request,
          duration,
        }
      );
    }
  }

  /**
   * Execute a sale (sell) trade to close a position
   * 
   * Complete flow:
   * 1. Load position from database
   * 2. Validate position exists and belongs to agent
   * 3. Get current token price from price feed
   * 4. Get token balance (verify sufficient balance)
   * 5. Get swap quote from swap service (Token → SOL)
   * 6. Execute swap (or use quote for simulation)
   * 7. Create sale transaction record and update balances atomically
   * 8. Create historical swap record
   * 9. Close position
   * 10. Invalidate caches
   * 
   * @param request - Sale execution request
   * @returns Sale execution result
   * @throws TradingExecutorError if execution fails at any step
   */
  async executeSale(request: SaleExecutionRequest): Promise<SaleExecutionResult> {
    // Acquire a per-position distributed lock to prevent concurrent operations
    // (e.g., stop-loss and manual sale racing against the same position)
    return this.withPositionLock(request.positionId, 'sale', async () => {
    const startTime = Date.now();

    // Idempotency check: prevent duplicate sale executions for the same position
    const saleKey = `sale:${request.positionId}`;
    const canProceed = await idempotencyService.checkAndSet(saleKey, REDIS_TTL.IDEMPOTENCY);

    if (!canProceed) {
      throw new TradingExecutorError(
        'Position is already being sold',
        'SALE_IN_PROGRESS',
        { positionId: request.positionId }
      );
    }

    // Store position at function scope for error logging
    let position: OpenPosition | null = null;

    try {
      // Step 1: Load position
      position = await positionService.getPositionById(request.positionId);

      if (!position) {
        throw new TradingExecutorError(
          `Position not found: ${request.positionId}`,
          'POSITION_NOT_FOUND',
          { positionId: request.positionId }
        );
      }

      // Step 2: Validate position belongs to agent
      if (position.agentId !== request.agentId) {
        throw new TradingExecutorError(
          'Position does not belong to agent',
          'POSITION_MISMATCH',
          { positionId: request.positionId, agentId: request.agentId }
        );
      }

      // Step 3: Get wallet address (use provided or from position)
      const walletAddress = request.walletAddress || position.walletAddress;
      if (!walletAddress) {
        throw new TradingExecutorError(
          'No wallet address available for position',
          'WALLET_NOT_FOUND',
          { positionId: request.positionId }
        );
      }

      // Step 4: Get wallet (needed for swap execution)
      const wallet = await this.agentRepo.findWalletByAddress(walletAddress);

      if (!wallet) {
        throw new TradingExecutorError(
          `Wallet not found: ${walletAddress}`,
          'WALLET_NOT_FOUND'
        );
      }

      const isSimulation = wallet.walletType === 'simulation';

      // Step 5: Get actual token balance to determine how much we can sell
      // This is the source of truth - position.remainingAmount may be out of sync
      // if take-profit sales reduced the balance but failed to update the position
      const tokenBalanceRecord = await prisma.agentBalance.findUnique({
        where: {
          walletAddress_tokenAddress: {
            walletAddress,
            tokenAddress: position.tokenAddress,
          },
        },
      });
      
      // Use actual balance as the amount to sell (fallback to position data if balance not found)
      const tokenAmountToSell = tokenBalanceRecord 
        ? parseFloat(tokenBalanceRecord.balance.toString())
        : (position.remainingAmount ?? position.purchaseAmount);
      
      if (tokenAmountToSell <= 0) {
        throw new TradingExecutorError(
          'No tokens to sell - balance is zero',
          'ZERO_BALANCE',
          { positionId: request.positionId, tokenAddress: position.tokenAddress }
        );
      }

      // Step 6: Parallelize independent operations
      // - Get current token price
      // - Get token decimals

      // Parallelize: Get price + Get decimals (independent operations)
      // Add timeouts to prevent hanging on slow external APIs
      const [tokenPrice, tokenDecimals] = await Promise.all([
        withTimeout(
          priceFeedService.getTokenPrice(position.tokenAddress),
          API_TIMEOUTS.DEXSCREENER,
          `Price fetch timed out for ${position.tokenAddress}`
        ),
        withTimeout(
          tokenMetadataService.getTokenDecimals(position.tokenAddress),
          API_TIMEOUTS.TOKEN_METADATA,
          `Token metadata fetch timed out for ${position.tokenAddress}`
        ),
      ]);

      const _currentPriceSol = tokenPrice.priceSol;
      const _currentPriceUsd = tokenPrice.priceUsd;

      // Convert to smallest units for swap
      const tokenAmountSmallestUnits = Math.floor(tokenAmountToSell * Math.pow(10, tokenDecimals));

      // Step 7: Get swap quote (Token → SOL)
      const swapQuote = await withTimeout(
        swapService.getQuote({
          inputMint: position.tokenAddress,
          outputMint: this.SOL_TOKEN_ADDRESS,
          amount: tokenAmountSmallestUnits,
          walletAddress: isSimulation ? undefined : wallet.walletAddress, // Jupiter rejects simulation wallet as taker; live needs taker for fees + tx
        }),
        API_TIMEOUTS.JUPITER_QUOTE,
        `Jupiter quote request timed out for ${position.tokenAddress}`
      );

      // Step 8: Execute swap (or use quote for simulation)
      const swapResult = await withTimeout(
        swapService.executeSwap({
          quote: swapQuote,
          walletAddress: wallet.walletAddress,
          isSimulation,
        }),
        API_TIMEOUTS.JUPITER_EXECUTE,
        `Swap execution timed out for ${position.tokenAddress}`
      );

      // Step 9: Convert amounts from smallest units (using Decimal for precision)
      // Jupiter returns amounts in smallest units (lamports for SOL, token's smallest unit for tokens)
      const solDecimals = 9; // SOL always has 9 decimals

      // Use Decimal for precise calculations to avoid floating-point precision loss
      // This is critical for very small token prices (e.g., 6.632e-11 SOL per token)
      const inputAmountDecimal = new Decimal(swapResult.inputAmount).div(Math.pow(10, tokenDecimals));
      const outputAmountDecimal = new Decimal(swapResult.outputAmount).div(Math.pow(10, solDecimals));

      // Calculate actual sale price (SOL per token) using Decimal for precision
      const calculatedSalePriceDecimal = outputAmountDecimal.div(inputAmountDecimal);

      // Convert to numbers for backward compatibility (but use Decimal for DB storage)
      const inputAmountTokens = inputAmountDecimal.toNumber();
      const outputAmountSol = outputAmountDecimal.toNumber();
      const calculatedSalePrice = calculatedSalePriceDecimal.toNumber();

      // Validate sale price (same validation as purchase)
      if (!inputAmountTokens || calculatedSalePriceDecimal.isZero() || !isFinite(calculatedSalePrice)) {
        throw new TradingExecutorError(
          'Invalid sale price calculated from swap result',
          'INVALID_SALE_PRICE',
          {
            inputAmountTokens,
            outputAmountSol,
            calculatedSalePrice,
            tokenDecimals,
          }
        );
      }

      // Step 10: Calculate profit/loss
      // Use cash-flow PnL: net SOL received (after protocol + network fees) minus total invested.
      // This stays correct when DCA happens after take-profits and reflects actual wallet PnL.
      const totalInvestedSol = position.totalInvestedSol ?? (position.purchasePrice * position.purchaseAmount);
      const { protocolFeeSol: saleProtocolFee, networkFeeSol: saleNetworkFee } = extractJupiterFees(swapResult.swapPayload);
      const netSaleSol = outputAmountSol - (saleProtocolFee ?? 0) - (saleNetworkFee ?? 0);
      let totalSolReceived = netSaleSol;
      const tpIds = position.takeProfitTransactionIds ?? [];
      if (tpIds.length > 0) {
        const tpTxs = await prisma.agentTransaction.findMany({
          where: { id: { in: tpIds } },
          select: { outputAmount: true, protocolFeeSol: true, networkFeeSol: true },
        });
        const solFromTpsNet = tpTxs.reduce(
          (sum, tx) => {
            const out = tx.outputAmount != null ? parseFloat(tx.outputAmount.toString()) : 0;
            const protocol = tx.protocolFeeSol != null ? parseFloat(tx.protocolFeeSol.toString()) : 0;
            const network = tx.networkFeeSol != null ? parseFloat(tx.networkFeeSol.toString()) : 0;
            return sum + (out - protocol - network);
          },
          0
        );
        totalSolReceived = solFromTpsNet + netSaleSol;
      }
      const profitLossSol = totalSolReceived - totalInvestedSol;
      const solPrice = await SolPriceService.getInstance().getSolPriceOrFetch();
      const profitLossUsd = profitLossSol * solPrice;

      const purchasePrice = position.purchasePrice;
      // Cost basis for change % (same as before)
      const originalCostBasisSol = purchasePrice * position.purchaseAmount;
      const changePercent = originalCostBasisSol > 0
        ? (profitLossSol / originalCostBasisSol) * 100
        : 0;

      // Get transaction value in USD - prefer swapUsdValue from Jupiter payload if available
      const saleSwapUsdValue = getSwapPayloadNumber(swapResult.swapPayload as Record<string, unknown> | null, 'swapUsdValue');
      const transactionValueUsd = typeof saleSwapUsdValue === 'number'
        ? saleSwapUsdValue
        : outputAmountSol * solPrice;
      // totalOutputAmount = outputAmountResult minus protocol fee (what the wallet actually receives before network fees)
      const totalOutputAmountSol = swapResult.totalOutputAmount != null
        ? new Decimal(swapResult.totalOutputAmount).div(Math.pow(10, solDecimals)).toNumber()
        : outputAmountSol - (saleProtocolFee ?? 0); // fallback for simulation
      // Net SOL to credit to balance: totalOutputAmount (protocol fee already deducted) minus network fee
      const balanceCreditSol = totalOutputAmountSol - (saleNetworkFee ?? 0);

      // Store position fields for use inside transaction callback
      // (TypeScript doesn't narrow nullability inside async callbacks)
      const tokenAddress = position.tokenAddress;
      const tokenSymbol = position.tokenSymbol;

      // Step 11: Get signal ID from purchase transaction (inherit from the signal that opened this position)
      let purchaseSignalId: number | null = null;
      if (position.purchaseTransactionId) {
        try {
          const purchaseTransaction = await prisma.agentTransaction.findUnique({
            where: { id: position.purchaseTransactionId },
            select: { signalId: true },
          });
          if (purchaseTransaction?.signalId) {
            purchaseSignalId = purchaseTransaction.signalId;
          }
        } catch (error) {
          // If purchase transaction not found or error, continue without signal ID
          // This can happen if transaction was deleted or doesn't exist
          logger.warn(
            { purchaseTransactionId: position.purchaseTransactionId, error: error instanceof Error ? error.message : String(error) },
            'Could not load purchase transaction for signal ID'
          );
        }
      }

      // Step 12: Create sale transaction, update balances, and close position atomically
      const now = new Date();
      const saleTransactionId = randomUUID();
      const historicalSwapId = randomUUID();

      // Wrap critical operations in a DB transaction for atomicity
      // If any step fails, all changes are rolled back
      // Use 15s timeout to accommodate multiple DB operations and potential network latency
      await prisma.$transaction(async (tx) => {
        // Create sale transaction record
        await tx.agentTransaction.create({
          data: {
            id: saleTransactionId,
            agent: { connect: { id: request.agentId } },
            wallet: { connect: { walletAddress: walletAddress } },
            transactionType: 'SWAP',
            transactionValueUsd: new Decimal(transactionValueUsd),
            transactionTime: now,
            signal: purchaseSignalId ? { connect: { id: purchaseSignalId } } : undefined,
            fees: new Decimal(swapResult.fees || 0),
            routes: swapResult.routes ? (swapResult.routes as Prisma.InputJsonValue) : Prisma.JsonNull,
            swapPayload: swapResult.swapPayload ? (swapResult.swapPayload as Prisma.InputJsonValue) : Prisma.JsonNull,
            inputMint: tokenAddress,
            inputSymbol: tokenSymbol,
            inputAmount: new Decimal(inputAmountTokens),
            inputPrice: calculatedSalePriceDecimal,
            outputMint: this.SOL_TOKEN_ADDRESS,
            outputSymbol: 'SOL',
            outputAmount: new Decimal(outputAmountSol),
            outputPrice: new Decimal(1.0), // SOL is base currency
            slippage: swapResult.slippage ? new Decimal(swapResult.slippage) : null,
            priceImpact: swapResult.priceImpact ? new Decimal(swapResult.priceImpact) : null,
            transactionHash: swapResult.transactionHash ?? null,
            protocolFeeSol: saleProtocolFee != null ? new Decimal(saleProtocolFee) : null,
            networkFeeSol: saleNetworkFee != null ? new Decimal(saleNetworkFee) : null,
          }
        });

        // Update balances (within transaction)
        // balanceCreditSol = outputAmountSol - networkFeeSol
        await balanceService.updateBalancesFromTransaction(
          walletAddress,
          request.agentId,
          'SWAP',
          tokenAddress,
          tokenSymbol,
          new Decimal(inputAmountTokens), // Token amount (decrease)
          this.SOL_TOKEN_ADDRESS,
          'SOL',
          new Decimal(balanceCreditSol), // Net SOL credited (minus network fee)
          tx // Pass transaction context for atomicity
        );

        // Close position in DB (within transaction)
        await tx.agentPosition.delete({
          where: { id: request.positionId },
        });
      }, { timeout: 15000 });

      // After transaction commits: Queue historical swap (async, non-critical)
      // Note: Using foreign key fields directly since transaction is guaranteed to exist
      // 
      // IMPORTANT: Historical swap records the FULL position, not just what was sold at the end
      // - amount: Original purchaseAmount (total tokens ever held)
      // - profitLoss: Includes realized profit from take-profits + final sale profit
      // - salePrice: Effective average (total SOL received / total tokens)
      // 
      // Calculate effective average sale price across all sales (take-profits + final close)
      // totalSolReceived was already computed in Step 10 (TP output amounts + final outputAmountSol)
      const effectiveAvgSalePrice = position.purchaseAmount > 0
        ? new Decimal(totalSolReceived).div(position.purchaseAmount)
        : calculatedSalePriceDecimal;
      
      await queueClient.getQueue(QueueName.DATABASE_WRITES).add(JobType.WRITE_HISTORICAL_SWAP, {
        type: JobType.WRITE_HISTORICAL_SWAP,
        data: {
          id: historicalSwapId,
          agentId: request.agentId,
          walletAddress: walletAddress,
          tokenAddress: position.tokenAddress,
          tokenSymbol: position.tokenSymbol,
          amount: new Decimal(position.purchaseAmount), // Original full position size
          purchasePrice: new Decimal(purchasePrice),
          salePrice: effectiveAvgSalePrice, // Weighted average across all sales
          changePercent: new Decimal(changePercent),
          profitLossUsd: new Decimal(profitLossUsd),
          profitLossSol: new Decimal(profitLossSol), // Cash-flow: total SOL received (TPs + final) minus totalInvestedSol
          purchaseTime: position.purchaseTransactionId ? position.createdAt : now, // Ideally fetch transaction time but position.createdAt is good proxy
          saleTime: now,
          purchaseTransactionId: position.purchaseTransactionId || null,
          saleTransactionId: saleTransactionId,
          signalId: purchaseSignalId || null,
          closeReason: request.reason || null,
        }
      });

      const result = {
        transactionId: saleTransactionId,
        historicalSwapId: historicalSwapId,
        positionId: request.positionId,
        inputAmount: inputAmountTokens,
        outputAmount: outputAmountSol,
        salePrice: calculatedSalePrice,
        profitLossSol,
        profitLossUsd,
        changePercent,
        transactionHash: swapResult.transactionHash || null,
      };

      // Step 12: Update Redis cache for affected balances (only the tokens that changed)
      // Fetch updated balances from DB and update Redis cache (same pattern as transaction handler)
      const tokensToUpdate = new Set<string>();
      tokensToUpdate.add(position.tokenAddress); // Token that was sold
      tokensToUpdate.add(this.SOL_TOKEN_ADDRESS); // SOL that was received

      for (const tokenAddress of tokensToUpdate) {
        try {
          const balance = await prisma.agentBalance.findUnique({
            where: {
              walletAddress_tokenAddress: {
                walletAddress,
                tokenAddress,
              },
            },
          });

          if (balance) {
            // Check if this is the token that was sold and if it's dust (< 0.001)
            if (tokenAddress === position.tokenAddress) {
              const balanceDecimal = new Decimal(balance.balance);
              const dustThreshold = new Decimal('0.001');

              if (balanceDecimal.lt(dustThreshold)) {
                // Delete dust balance from DB and Redis
                await prisma.agentBalance.delete({
                  where: { id: balance.id },
                });
                await redisBalanceService.invalidateBalance(
                  balance.agentId,
                  walletAddress,
                  tokenAddress
                );
                logger.debug({
                  agentId: request.agentId,
                  walletAddress,
                  tokenAddress,
                  balance: balance.balance,
                }, 'Deleted dust balance after position close');
                continue; // Skip Redis setBalance since we deleted it
              }
            }

            // Normal Redis cache update for non-dust balances
            await redisBalanceService.setBalance({
              id: balance.id,
              agentId: balance.agentId,
              walletAddress: balance.walletAddress,
              tokenAddress: balance.tokenAddress,
              tokenSymbol: balance.tokenSymbol,
              balance: balance.balance,
              lastUpdated: balance.lastUpdated,
            });
          }
        } catch (error) {
          // Log but don't fail - cache update is best-effort
          logger.warn(
            { agentId: request.agentId, walletAddress, tokenAddress, error: error instanceof Error ? error.message : String(error) },
            'Failed to update cache for balance after sale'
          );
        }
      }

      // Delete position from Redis cache
      await redisPositionService.deletePosition(position);

      positionEventEmitter.emitPositionClosed({
        agentId: request.agentId,
        walletAddress,
        positionId: request.positionId,
        tokenAddress,
        tokenSymbol: position.tokenSymbol,
      });

      // Record metrics and log
      const duration = Date.now() - startTime;
      const durationSeconds = duration / 1000;

      tradeExecutionLatency.observe({ type: 'sale', status: 'success' }, durationSeconds);
      tradeExecutionCount.inc({ type: 'sale', status: 'success' });

      logger.info({
        agentId: request.agentId,
        positionId: request.positionId,
        tokenAddress: position.tokenAddress,
        transactionId: result.transactionId,
        profitLossSol: result.profitLossSol,
        profitLossUsd: result.profitLossUsd,
        changePercent: result.changePercent,
        duration,
      }, 'Sale executed successfully');

      // Return success result
      return {
        success: true,
        ...result,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const durationSeconds = duration / 1000;

      // Record metrics
      tradeExecutionLatency.observe({ type: 'sale', status: 'failed' }, durationSeconds);
      tradeExecutionCount.inc({ type: 'sale', status: 'failed' });
      errorCount.inc({ type: 'trading', code: error instanceof TradingExecutorError ? error.code : 'EXECUTION_FAILED' });

      if (error instanceof TradingExecutorError) {
        logger.error({
          agentId: request.agentId,
          positionId: request.positionId,
          error: error.message,
          code: error.code,
          duration,
        }, 'Sale failed');
        throw error;
      }

      // Wrap unexpected errors with better context
      // Check if it's a BalanceError to include balance details
      // Use typeof check to ensure BalanceError is a constructor before using instanceof
      const isBalanceError = typeof BalanceError !== 'undefined' && 
                             typeof BalanceError === 'function' && 
                             error instanceof BalanceError;
      const errorLog: Record<string, unknown> = {
        agentId: request.agentId,
        positionId: request.positionId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        duration,
      };

      // Add BalanceError-specific fields if available
      if (isBalanceError) {
        errorLog.currentBalance = error.currentBalance;
        errorLog.requiredAmount = error.requiredAmount;
        errorLog.tokenAddress = error.tokenAddress;
        errorLog.tokenSymbol = error.tokenSymbol;

        // Also log position amount for comparison (we already have position loaded)
        if (position) {
          errorLog.positionPurchaseAmount = position.purchaseAmount;
          errorLog.positionTokenAddress = position.tokenAddress;
          errorLog.positionTokenSymbol = position.tokenSymbol;
        }
      }

      logger.error(errorLog, 'Sale failed with unexpected error');

      throw new TradingExecutorError(
        `Sale execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EXECUTION_FAILED',
        {
          originalError: error instanceof Error ? error.message : String(error),
          request,
          duration,
        }
      );
    } finally {
      // Always clear idempotency key, even if sale succeeded or failed
      // This allows retry after failure (after TTL expires) or prevents stale locks
      await idempotencyService.clear(saleKey);
    }
    }); // end withPositionLock
  }

  /**
   * Execute a DCA (Dollar Cost Averaging) buy to add to an existing position
   * 
   * Complete flow:
   * 1. Load position and validate
   * 2. Get wallet for swap execution
   * 3. Verify agent has sufficient SOL balance (ignore maxPurchasePerToken)
   * 4. Get swap quote (SOL → Token)
   * 5. Execute swap
   * 6. Create transaction record with isDca=true
   * 7. Update position (average price, total amount, DCA count, etc.)
   * 8. Update caches
   * 
   * @param request - DCA buy request
   * @returns DCA buy result
   * @throws TradingExecutorError if execution fails
   */
  async executeDCABuy(request: DCABuyRequest): Promise<DCABuyResult> {
    // Acquire a per-position distributed lock to prevent concurrent operations
    return this.withPositionLock(request.positionId, 'dca', async () => {
    const startTime = Date.now();

    // Idempotency check: prevent duplicate DCA executions for the same trigger level
    // Key includes dcaCount + dropPercent so each DCA attempt gets a unique key
    const dcaKey = `dca:${request.positionId}:${request.dcaCount}:${request.triggerLevel.dropPercent}`;
    const canProceed = await idempotencyService.checkAndSet(dcaKey, REDIS_TTL.IDEMPOTENCY);

    if (!canProceed) {
      throw new TradingExecutorError(
        'DCA buy already in progress for this position',
        'DCA_IN_PROGRESS',
        { positionId: request.positionId }
      );
    }

    let position: OpenPosition | null = null;

    try {
      // Step 1: Load position
      position = await positionService.getPositionById(request.positionId);

      if (!position) {
        throw new TradingExecutorError(
          `Position not found: ${request.positionId}`,
          'POSITION_NOT_FOUND',
          { positionId: request.positionId }
        );
      }

      // Validate position belongs to agent
      if (position.agentId !== request.agentId) {
        throw new TradingExecutorError(
          'Position does not belong to agent',
          'POSITION_MISMATCH',
          { positionId: request.positionId, agentId: request.agentId }
        );
      }

      const walletAddress = position.walletAddress;

      // Get signalId from the position's purchase transaction
      let signalId: number | null = null;
      if (position.purchaseTransactionId) {
        const purchaseTransaction = await this.transactionRepo.findById(position.purchaseTransactionId);
        signalId = purchaseTransaction?.signalId ?? null;
      }

      // Step 2: Get wallet (needed for swap execution)
      const wallet = await this.agentRepo.findWalletByAddress(walletAddress);

      if (!wallet) {
        throw new TradingExecutorError(
          `Wallet not found: ${walletAddress}`,
          'WALLET_NOT_FOUND'
        );
      }

      const isSimulation = wallet.walletType === 'simulation';

      // Step 3: Verify sufficient SOL balance (no maxPurchasePerToken check for DCA)
      const solBalance = await redisBalanceService.getBalance(
        request.agentId,
        walletAddress,
        this.SOL_TOKEN_ADDRESS
      );

      const solBalanceNum = solBalance ? parseFloat(solBalance.balance) : 0;

      if (solBalanceNum < request.buyAmountSol) {
        throw new TradingExecutorError(
          `Insufficient SOL balance for DCA: have ${solBalanceNum.toFixed(4)}, need ${request.buyAmountSol.toFixed(4)}`,
          'INSUFFICIENT_BALANCE',
          {
            available: solBalanceNum,
            required: request.buyAmountSol,
            positionId: request.positionId,
          }
        );
      }

      // Step 4: Get swap quote
      const buyAmountLamports = Math.floor(request.buyAmountSol * 1e9);

      const [tokenDecimals, swapQuote] = await Promise.all([
        withTimeout(
          tokenMetadataService.getTokenDecimals(position.tokenAddress),
          API_TIMEOUTS.TOKEN_METADATA,
          `Token metadata fetch timed out for ${position.tokenAddress}`
        ),
        withTimeout(
          swapService.getQuote({
            inputMint: this.SOL_TOKEN_ADDRESS,
            outputMint: position.tokenAddress,
            amount: buyAmountLamports,
            walletAddress: isSimulation ? undefined : wallet.walletAddress,
          }),
          API_TIMEOUTS.JUPITER_QUOTE,
          `Jupiter quote request timed out for ${position.tokenAddress}`
        ),
      ]);

      // Step 5: Execute swap
      const swapResult = await withTimeout(
        swapService.executeSwap({
          quote: swapQuote,
          walletAddress: wallet.walletAddress,
          isSimulation,
        }),
        API_TIMEOUTS.JUPITER_EXECUTE,
        `DCA swap execution timed out for ${position.tokenAddress}`
      );

      // Convert amounts
      const solDecimals = 9;
      const inputAmountDecimal = new Decimal(swapResult.inputAmount).div(Math.pow(10, solDecimals));
      const outputAmountDecimal = new Decimal(swapResult.outputAmount).div(Math.pow(10, tokenDecimals));

      const totalInputAmountSol = swapResult.totalInputAmount != null
        ? new Decimal(swapResult.totalInputAmount).div(Math.pow(10, solDecimals)).toNumber()
        : inputAmountDecimal.toNumber();
      const inputAmountSol = inputAmountDecimal.toNumber();
      const outputAmountTokens = outputAmountDecimal.toNumber();
      const dcaPurchasePrice = inputAmountDecimal.div(outputAmountDecimal).toNumber();

      // Get transaction value in USD (use total SOL debited when available)
      const solPrice = await SolPriceService.getInstance().getSolPriceOrFetch();
      const dcaSwapUsdValue = getSwapPayloadNumber(swapResult.swapPayload as Record<string, unknown> | null, 'swapUsdValue');
      const transactionValueUsd = typeof dcaSwapUsdValue === 'number'
        ? dcaSwapUsdValue
        : totalInputAmountSol * solPrice;

      // Extract fees from Jupiter payload
      const { protocolFeeSol: dcaProtocolFee, networkFeeSol: dcaNetworkFee } = extractJupiterFees(swapResult.swapPayload);
      // Total SOL to debit from balance: totalInputAmount (includes protocol fee) + network fee
      const dcaBalanceDebitSol = totalInputAmountSol + (dcaNetworkFee ?? 0);

      // Step 6: Create transaction and update balances atomically
      const transactionId = randomUUID();
      const now = new Date();

      const transactionData = {
        id: transactionId,
        agent: { connect: { id: request.agentId } },
        wallet: { connect: { walletAddress: walletAddress } },
        transactionType: 'SWAP' as const,
        transactionValueUsd: new Decimal(transactionValueUsd),
        transactionTime: now,
        fees: new Decimal(swapResult.fees || 0),
        routes: swapResult.routes ? (swapResult.routes as Prisma.InputJsonValue) : Prisma.JsonNull,
        swapPayload: swapResult.swapPayload ? (swapResult.swapPayload as Prisma.InputJsonValue) : Prisma.JsonNull,
        inputMint: this.SOL_TOKEN_ADDRESS,
        inputSymbol: 'SOL',
        inputAmount: new Decimal(inputAmountSol), // Raw swap amount (fees stored separately)
        inputPrice: new Decimal(1.0),
        outputMint: position.tokenAddress,
        outputSymbol: position.tokenSymbol,
        outputAmount: new Decimal(outputAmountTokens),
        outputPrice: new Decimal(dcaPurchasePrice),
        slippage: swapResult.slippage ? new Decimal(swapResult.slippage) : null,
        priceImpact: swapResult.priceImpact ? new Decimal(swapResult.priceImpact) : null,
        transactionHash: swapResult.transactionHash ?? null,
        signal: signalId ? { connect: { id: signalId } } : undefined,
        isDca: true,
        protocolFeeSol: dcaProtocolFee != null ? new Decimal(dcaProtocolFee) : null,
        networkFeeSol: dcaNetworkFee != null ? new Decimal(dcaNetworkFee) : null,
      };

      // Use 15s timeout to accommodate multiple DB operations and potential network latency
      await prisma.$transaction(async (tx) => {
        // Create transaction record
        await this.transactionRepo.create(transactionData, tx);

        // Update balances
        await balanceService.updateBalancesFromTransaction(
          walletAddress,
          request.agentId,
          'SWAP',
          this.SOL_TOKEN_ADDRESS,
          'SOL',
          new Decimal(dcaBalanceDebitSol), // Total SOL debited (protocol + network fees)
          position!.tokenAddress,
          position!.tokenSymbol,
          new Decimal(outputAmountTokens),
          tx
        );
      }, { timeout: 15000 });

      // Step 7: Update position with new averages (use total SOL debited for totalInvested)
      const { newAveragePrice, newTotalAmount, newTotalInvested } = dcaManager.calculateNewAveragePrice(
        position.totalInvestedSol,
        position.purchaseAmount,
        dcaBalanceDebitSol,
        outputAmountTokens
      );

      // Load config to get TP levels count for append-levels model
      const agentConfig = await configService.loadAgentConfig(position.agentId);
      const configTpLevelsCount = agentConfig.takeProfit?.levels?.length ?? 4;

      const updatedPosition = await positionService.updatePositionAfterDCA(
        request.positionId,
        {
          newAveragePurchasePrice: newAveragePrice,
          newTotalPurchaseAmount: newTotalAmount,
          newTotalInvestedSol: newTotalInvested,
          dcaTransactionId: transactionId,
          newTokensAcquired: outputAmountTokens,
          configTpLevelsCount,
        }
      );

      // Re-initialize stop-loss from the new cost basis.
      // DCA lowers purchasePrice (weighted average) while peakPrice stays at the old
      // high. This creates a phantom "gain" (peakPrice >> purchasePrice) that can
      // tighten the trailing stop-loss above the current market price, triggering an
      // immediate sell. Resetting peakPrice and currentStopLossPercentage to match the
      // new cost basis prevents this. (see: github issue #32)
      await stopLossManager.initializeStopLoss(
        request.positionId,
        newAveragePrice,
        agentConfig
      );

      // Step 8: Update Redis caches for balances
      const inputBalance = await prisma.agentBalance.findUnique({
        where: {
          walletAddress_tokenAddress: {
            walletAddress,
            tokenAddress: this.SOL_TOKEN_ADDRESS,
          },
        },
      });

      const outputBalance = await prisma.agentBalance.findUnique({
        where: {
          walletAddress_tokenAddress: {
            walletAddress,
            tokenAddress: position.tokenAddress,
          },
        },
      });

      if (inputBalance) {
        await redisBalanceService.setBalance({
          id: inputBalance.id,
          agentId: inputBalance.agentId,
          walletAddress: inputBalance.walletAddress,
          tokenAddress: inputBalance.tokenAddress,
          tokenSymbol: inputBalance.tokenSymbol,
          balance: inputBalance.balance,
          lastUpdated: inputBalance.lastUpdated,
        });
      }

      if (outputBalance) {
        await redisBalanceService.setBalance({
          id: outputBalance.id,
          agentId: outputBalance.agentId,
          walletAddress: outputBalance.walletAddress,
          tokenAddress: outputBalance.tokenAddress,
          tokenSymbol: outputBalance.tokenSymbol,
          balance: outputBalance.balance,
          lastUpdated: outputBalance.lastUpdated,
        });
      }

      // Record metrics and log
      const duration = Date.now() - startTime;
      const durationSeconds = duration / 1000;

      tradeExecutionLatency.observe({ type: 'dca_buy', status: 'success' }, durationSeconds);
      tradeExecutionCount.inc({ type: 'dca_buy', status: 'success' });

      logger.info({
        agentId: request.agentId,
        positionId: request.positionId,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        transactionId,
        solSpent: totalInputAmountSol,
        tokensAcquired: outputAmountTokens,
        oldAveragePrice: position.purchasePrice,
        newAveragePrice,
        newDcaCount: updatedPosition.dcaCount,
        triggerLevel: request.triggerLevel,
        duration,
      }, 'DCA buy executed successfully');

      return {
        success: true,
        transactionId,
        positionId: request.positionId,
        tokensAcquired: outputAmountTokens,
        solSpent: totalInputAmountSol,
        newAveragePrice,
        newTotalAmount,
        newDcaCount: updatedPosition.dcaCount,
        transactionHash: swapResult.transactionHash || null,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const durationSeconds = duration / 1000;

      tradeExecutionLatency.observe({ type: 'dca_buy', status: 'failed' }, durationSeconds);
      tradeExecutionCount.inc({ type: 'dca_buy', status: 'failed' });

      const errorMessage = error instanceof Error ? error.message : String(error);
      const isExpectedError = errorMessage.includes('Insufficient') ||
        errorMessage.includes('INSUFFICIENT_BALANCE') ||
        errorMessage.includes('already in progress');

      if (error instanceof TradingExecutorError) {
        // Log expected errors at debug level, others at warn
        if (isExpectedError) {
          logger.debug({ error: error.message, code: error.code }, 'DCA skipped');
        } else {
          logger.warn({ error: error.message, code: error.code }, 'DCA buy failed');
        }
        throw error;
      }

      // Log expected errors at debug level, unexpected at error level
      if (isExpectedError) {
        logger.debug({ error: errorMessage }, 'DCA skipped');
      } else {
        logger.error({ error: errorMessage }, 'DCA buy failed');
      }

      throw new TradingExecutorError(
        `DCA buy execution failed: ${errorMessage}`,
        'DCA_EXECUTION_FAILED',
        {
          originalError: errorMessage,
          request,
          duration,
        }
      );
    } finally {
      await idempotencyService.clear(dcaKey);
    }
    }); // end withPositionLock
  }

  /**
   * Execute a take-profit sale (partial position sale)
   * 
   * Unlike executeSale which closes the entire position, this:
   * 1. Sells only the specified amount of tokens
   * 2. Updates the position's remaining amount (doesn't close it)
   * 3. Optionally activates moon bag
   * 
   * @param request - Take-profit sale request
   * @returns Take-profit sale result
   * @throws TradingExecutorError if execution fails
   */
  async executeTakeProfitSale(request: TakeProfitSaleRequest): Promise<TakeProfitSaleResult> {
    // Acquire a per-position distributed lock to prevent concurrent operations
    return this.withPositionLock(request.positionId, 'take-profit', async () => {
    const startTime = Date.now();

    // Idempotency check: prevent duplicate take-profit executions
    const tpKey = `take-profit:${request.positionId}:${request.levelsExecuted}`;
    const canProceed = await idempotencyService.checkAndSet(tpKey, REDIS_TTL.IDEMPOTENCY);

    if (!canProceed) {
      throw new TradingExecutorError(
        'Take-profit sale already in progress',
        'TAKE_PROFIT_IN_PROGRESS',
        { positionId: request.positionId }
      );
    }

    let position: OpenPosition | null = null;

    try {
      // Step 1: Load position
      position = await positionService.getPositionById(request.positionId);

      if (!position) {
        throw new TradingExecutorError(
          `Position not found: ${request.positionId}`,
          'POSITION_NOT_FOUND',
          { positionId: request.positionId }
        );
      }

      // Step 2: Validate position belongs to agent
      if (position.agentId !== request.agentId) {
        throw new TradingExecutorError(
          'Position does not belong to agent',
          'POSITION_MISMATCH',
          { positionId: request.positionId, agentId: request.agentId }
        );
      }

      // Step 3: Validate sell amount
      const effectiveRemaining = position.remainingAmount ?? position.purchaseAmount;
      if (request.sellAmount <= 0 || request.sellAmount > effectiveRemaining) {
        throw new TradingExecutorError(
          `Invalid sell amount: ${request.sellAmount} (remaining: ${effectiveRemaining})`,
          'INVALID_SELL_AMOUNT',
          { sellAmount: request.sellAmount, remaining: effectiveRemaining }
        );
      }

      // Step 4: Get wallet
      const walletAddress = position.walletAddress;
      const wallet = await this.agentRepo.findWalletByAddress(walletAddress);

      if (!wallet) {
        throw new TradingExecutorError(
          `Wallet not found: ${walletAddress}`,
          'WALLET_NOT_FOUND'
        );
      }

      const isSimulation = wallet.walletType === 'simulation';

      // Step 5: Get token decimals first, then get quote with correct decimals
      const tokenDecimals = await withTimeout(
        tokenMetadataService.getTokenDecimals(position.tokenAddress),
        API_TIMEOUTS.TOKEN_METADATA,
        `Token metadata fetch timed out for ${position.tokenAddress}`
      );

      // Convert sell amount to smallest units using CORRECT token decimals
      const tokenAmountSmallestUnits = Math.floor(request.sellAmount * Math.pow(10, tokenDecimals));
      
      const finalQuote = await withTimeout(
        swapService.getQuote({
          inputMint: position.tokenAddress,
          outputMint: this.SOL_TOKEN_ADDRESS,
          amount: tokenAmountSmallestUnits,
          walletAddress: isSimulation ? undefined : wallet.walletAddress, // Jupiter rejects simulation wallet as taker; live needs taker for fees + tx
        }),
        API_TIMEOUTS.JUPITER_QUOTE,
        `Jupiter quote request timed out for ${position.tokenAddress}`
      );

      // Step 6: Execute swap
      const swapResult = await withTimeout(
        swapService.executeSwap({
          quote: finalQuote,
          walletAddress: wallet.walletAddress,
          isSimulation,
        }),
        API_TIMEOUTS.JUPITER_EXECUTE,
        `Swap execution timed out for ${position.tokenAddress}`
      );

      // Step 7: Convert amounts
      const solDecimals = 9;
      const inputAmountDecimal = new Decimal(swapResult.inputAmount).div(Math.pow(10, tokenDecimals));
      const outputAmountDecimal = new Decimal(swapResult.outputAmount).div(Math.pow(10, solDecimals));
      const calculatedSalePriceDecimal = outputAmountDecimal.div(inputAmountDecimal);

      const inputAmountTokens = inputAmountDecimal.toNumber();
      const outputAmountSol = outputAmountDecimal.toNumber();
      const calculatedSalePrice = calculatedSalePriceDecimal.toNumber();

      // Validate sale price
      if (!inputAmountTokens || calculatedSalePriceDecimal.isZero() || !isFinite(calculatedSalePrice)) {
        throw new TradingExecutorError(
          'Invalid sale price calculated from swap result',
          'INVALID_SALE_PRICE',
          { inputAmountTokens, outputAmountSol, calculatedSalePrice }
        );
      }

      // Step 8: Extract fees and calculate profit/loss for this partial sale
      // Fees must be extracted FIRST so PnL uses net amounts (consistent with balance updates).
      const { protocolFeeSol: tpProtocolFee, networkFeeSol: tpNetworkFee } = extractJupiterFees(swapResult.swapPayload);

      // Net SOL received after all fees (matches what balance is credited)
      const tpNetSaleSol = outputAmountSol - (tpProtocolFee ?? 0) - (tpNetworkFee ?? 0);

      // Proportional cost basis from totalInvestedSol (includes buy-side fees)
      const totalInvestedSol = position.totalInvestedSol ?? (position.purchasePrice * position.purchaseAmount);
      const costBasis = position.purchaseAmount > 0
        ? (inputAmountTokens / position.purchaseAmount) * totalInvestedSol
        : 0;

      const profitLossSol = tpNetSaleSol - costBasis;
      const solPrice = await SolPriceService.getInstance().getSolPriceOrFetch();
      const profitLossUsd = profitLossSol * solPrice;
      const purchasePrice = position.purchasePrice;
      const changePercent = purchasePrice > 0
        ? ((calculatedSalePrice - purchasePrice) / purchasePrice) * 100
        : 0;

      // Get transaction value in USD
      const tpSwapUsdValue = getSwapPayloadNumber(swapResult.swapPayload as Record<string, unknown> | null, 'swapUsdValue');
      const transactionValueUsd = typeof tpSwapUsdValue === 'number'
        ? tpSwapUsdValue
        : outputAmountSol * solPrice;
      // totalOutputAmount = outputAmountResult minus protocol fee (what the wallet actually receives before network fees)
      const tpTotalOutputAmountSol = swapResult.totalOutputAmount != null
        ? new Decimal(swapResult.totalOutputAmount).div(Math.pow(10, solDecimals)).toNumber()
        : outputAmountSol - (tpProtocolFee ?? 0); // fallback for simulation
      // Net SOL to credit to balance: totalOutputAmount (protocol fee already deducted) minus network fee
      const tpBalanceCreditSol = tpTotalOutputAmountSol - (tpNetworkFee ?? 0);

      // Step 9: Create transaction and update position in DB transaction
      const now = new Date();
      const transactionId = randomUUID();

      // Get signal ID from purchase transaction
      let purchaseSignalId: number | null = null;
      if (position.purchaseTransactionId) {
        try {
          const purchaseTransaction = await prisma.agentTransaction.findUnique({
            where: { id: position.purchaseTransactionId },
            select: { signalId: true },
          });
          purchaseSignalId = purchaseTransaction?.signalId || null;
        } catch (_error) {
          // Continue without signal ID
        }
      }

      await prisma.$transaction(async (tx) => {
        // Create take-profit transaction record
        await tx.agentTransaction.create({
          data: {
            id: transactionId,
            agent: { connect: { id: request.agentId } },
            wallet: { connect: { walletAddress: walletAddress } },
            transactionType: 'SWAP',
            transactionValueUsd: new Decimal(transactionValueUsd),
            transactionTime: now,
            signal: purchaseSignalId ? { connect: { id: purchaseSignalId } } : undefined,
            fees: new Decimal(swapResult.fees || 0),
            routes: swapResult.routes ? (swapResult.routes as Prisma.InputJsonValue) : Prisma.JsonNull,
            swapPayload: swapResult.swapPayload ? (swapResult.swapPayload as Prisma.InputJsonValue) : Prisma.JsonNull,
            inputMint: position!.tokenAddress,
            inputSymbol: position!.tokenSymbol,
            inputAmount: new Decimal(inputAmountTokens),
            inputPrice: calculatedSalePriceDecimal,
            outputMint: this.SOL_TOKEN_ADDRESS,
            outputSymbol: 'SOL',
            outputAmount: new Decimal(outputAmountSol),
            outputPrice: new Decimal(1.0),
            slippage: swapResult.slippage ? new Decimal(swapResult.slippage) : null,
            priceImpact: swapResult.priceImpact ? new Decimal(swapResult.priceImpact) : null,
            transactionHash: swapResult.transactionHash ?? null,
            isTakeProfit: true, // Mark as take-profit transaction
            protocolFeeSol: tpProtocolFee != null ? new Decimal(tpProtocolFee) : null,
            networkFeeSol: tpNetworkFee != null ? new Decimal(tpNetworkFee) : null,
          },
        });

        // Update balances
        // tpBalanceCreditSol = outputAmountSol - networkFeeSol
        await balanceService.updateBalancesFromTransaction(
          walletAddress,
          request.agentId,
          'SWAP',
          position!.tokenAddress,
          position!.tokenSymbol,
          new Decimal(inputAmountTokens), // Token amount (decrease)
          this.SOL_TOKEN_ADDRESS,
          'SOL',
          new Decimal(tpBalanceCreditSol), // Net SOL credited (minus network fee)
          tx
        );
      }, { timeout: 15000 });

      // Step 10: Update position after DB transaction
      const updatedPosition = await positionService.updatePositionAfterTakeProfit(
        request.positionId,
        {
          newRemainingAmount: request.newRemainingAmount,
          levelsExecuted: request.levelsExecuted,
          takeProfitTransactionId: transactionId,
          activateMoonBag: request.activateMoonBag,
          moonBagAmount: request.moonBagAmount,
          profitLossSol, // Accumulate realized profit on the position
        }
      );

      // Step 10b: If position fully sold (no moonbag, remaining amount is dust), close position and create historical swap
      if (
        request.newRemainingAmount < TAKE_PROFIT_DUST_THRESHOLD &&
        !request.activateMoonBag
      ) {
        const totalRealizedProfitSol = updatedPosition.realizedProfitSol ?? 0;
        const originalCostBasisSol = position.purchasePrice * position.purchaseAmount;
        const totalSolReceived = originalCostBasisSol + totalRealizedProfitSol;
        const effectiveAvgSalePrice = position.purchaseAmount > 0
          ? totalSolReceived / position.purchaseAmount
          : calculatedSalePrice;
        const changePercent = originalCostBasisSol > 0
          ? (totalRealizedProfitSol / originalCostBasisSol) * 100
          : 0;
        const profitLossUsdTotal = totalRealizedProfitSol * solPrice;
        const historicalSwapId = randomUUID();

        await queueClient.getQueue(QueueName.DATABASE_WRITES).add(JobType.WRITE_HISTORICAL_SWAP, {
          type: JobType.WRITE_HISTORICAL_SWAP,
          data: {
            id: historicalSwapId,
            agentId: request.agentId,
            walletAddress: walletAddress,
            tokenAddress: position.tokenAddress,
            tokenSymbol: position.tokenSymbol,
            amount: new Decimal(position.purchaseAmount),
            purchasePrice: new Decimal(position.purchasePrice),
            salePrice: new Decimal(effectiveAvgSalePrice),
            changePercent: new Decimal(changePercent),
            profitLossUsd: new Decimal(profitLossUsdTotal),
            profitLossSol: new Decimal(totalRealizedProfitSol),
            purchaseTime: position.purchaseTransactionId ? position.createdAt : now,
            saleTime: now,
            purchaseTransactionId: position.purchaseTransactionId || null,
            saleTransactionId: transactionId,
            signalId: purchaseSignalId || null,
            closeReason: 'take_profit',
          },
        });

        await positionService.closePosition(request.positionId);

        // Invalidate balance caches (same as normal take-profit path)
        await redisBalanceService.invalidateWalletBalances(request.agentId, walletAddress);

        logger.info({
          positionId: request.positionId,
          agentId: request.agentId,
          tokenSymbol: position.tokenSymbol,
          historicalSwapId,
          profitLossSol: totalRealizedProfitSol,
          changePercent,
        }, 'Position closed after take-profit fully sold (no moonbag)');

        return {
          success: true,
          transactionId,
          positionId: request.positionId,
          tokensSold: inputAmountTokens,
          solReceived: outputAmountSol,
          salePrice: calculatedSalePrice,
          profitLossSol,
          profitLossUsd,
          changePercent,
          newRemainingAmount: request.newRemainingAmount,
          newLevelsHit: updatedPosition.takeProfitLevelsHit,
          moonBagActivated: request.activateMoonBag,
          transactionHash: swapResult.transactionHash || null,
          positionClosed: true,
          historicalSwapId,
        };
      }

      // Step 11: Invalidate balance caches
      // Note: Position cache is already updated by updatePositionAfterTakeProfit
      await redisBalanceService.invalidateWalletBalances(request.agentId, walletAddress);

      const duration = Date.now() - startTime;

      // Record metrics
      tradeExecutionLatency.observe({ type: 'take_profit', status: 'success' }, duration / 1000);
      tradeExecutionCount.inc({ type: 'take_profit', status: 'success' });

      logger.info({
        positionId: request.positionId,
        agentId: request.agentId,
        tokenSymbol: position.tokenSymbol,
        tokensSold: inputAmountTokens,
        solReceived: outputAmountSol,
        profitLossSol,
        changePercent: changePercent.toFixed(2),
        levelsExecuted: request.levelsExecuted,
        newRemainingAmount: request.newRemainingAmount,
        moonBagActivated: request.activateMoonBag,
        duration,
      }, 'Take-profit sale completed');

      return {
        success: true,
        transactionId,
        positionId: request.positionId,
        tokensSold: inputAmountTokens,
        solReceived: outputAmountSol,
        salePrice: calculatedSalePrice,
        profitLossSol,
        profitLossUsd,
        changePercent,
        newRemainingAmount: request.newRemainingAmount,
        newLevelsHit: updatedPosition.takeProfitLevelsHit,
        moonBagActivated: request.activateMoonBag,
        transactionHash: swapResult.transactionHash || null,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      tradeExecutionLatency.observe({ type: 'take_profit', status: 'failed' }, duration / 1000);
      tradeExecutionCount.inc({ type: 'take_profit', status: 'failed' });
      errorCount.inc({ type: 'take_profit', code: 'EXECUTION_FAILED' });

      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error({
        positionId: request.positionId,
        agentId: request.agentId,
        tokenSymbol: position?.tokenSymbol,
        error: errorMessage,
        duration,
      }, 'Take-profit sale failed');

      throw new TradingExecutorError(
        `Take-profit sale execution failed: ${errorMessage}`,
        'TAKE_PROFIT_EXECUTION_FAILED',
        { originalError: errorMessage, request, duration }
      );
    } finally {
      await idempotencyService.clear(tpKey);
    }
    }); // end withPositionLock
  }

  /**
   * Get default wallet address for an agent based on trading mode
   * 
   * @param agentId - Agent ID
   * @returns Wallet address or null if not found
   */
  private async getDefaultWalletAddress(agentId: string): Promise<string | null> {
    // Look up agent to determine trading mode, then find corresponding wallet
    const agent = await this.agentRepo.findById(agentId);

    if (!agent) {
      return null;
    }

    const activeWallet = await this.agentRepo.findWalletByAgentId(agentId, agent.tradingMode as 'simulation' | 'live');
    return activeWallet?.walletAddress || null;
  }
}

// Export singleton instance
export const tradingExecutor = new TradingExecutor(
  new AgentRepository(),
  new PositionRepository(),
  new TransactionRepository()
);

// Export class for testing or custom instances
export { TradingExecutor };

