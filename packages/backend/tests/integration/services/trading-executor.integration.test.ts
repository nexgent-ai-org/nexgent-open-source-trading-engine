/**
 * Trading Executor Integration Tests
 *
 * Tests trade execution orchestration with real Prisma, Redis, and domain services.
 * Mocks ONLY external HTTP boundaries: Jupiter (swap), token metadata (Solana RPC), Pyth (SOL price).
 *
 * Validates:
 * - Decimal arithmetic for amounts and purchase price
 * - Position and transaction creation in DB
 * - Balance updates
 */

process.env.REDIS_DB = '1';

import { randomUUID } from 'crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { TransactionType } from '@prisma/client';
import { tradingExecutor } from '@/domain/trading/trading-executor.service.js';
import { redisService } from '@/infrastructure/cache/redis-client.js';
import { getTestPrisma, cleanupTestDatabase, disconnectTestDatabase } from '../../helpers/test-db.js';
import { getTestRedis, connectTestRedis, cleanupTestRedis, disconnectTestRedis } from '../../helpers/test-redis.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TEST_TOKEN = 'Token1111111111111111111111111111111111111111';
const POSITION_SIZE_SOL = 1;
const POSITION_SIZE_LAMPORTS = 1e9;

// Mock external HTTP boundaries only
jest.mock('@/infrastructure/external/jupiter/index.js', () => ({
  swapService: {
    getQuote: jest.fn(),
    executeSwap: jest.fn(),
  },
  SOL_MINT_ADDRESS: 'So11111111111111111111111111111111111111112',
}));

jest.mock('@/infrastructure/external/solana/token-metadata-service.js', () => ({
  tokenMetadataService: {
    getTokenDecimals: jest.fn().mockResolvedValue(6),
  },
}));

jest.mock('@/infrastructure/external/jupiter/price/sol-price-service.js', () => ({
  SolPriceService: {
    getInstance: jest.fn(() => ({
      getSolPriceOrFetch: jest.fn().mockResolvedValue(100), // $100 per SOL
      getSolPrice: jest.fn().mockReturnValue(100),
      isPriceStale: jest.fn().mockReturnValue(false),
      isHealthy: jest.fn().mockReturnValue(true),
      updateFromPoll: jest.fn(),
    })),
  },
  SOL_MINT: 'So11111111111111111111111111111111111111112',
}));

// Mock queue to avoid real job processing
jest.mock('@/infrastructure/queue/queue-client.js', () => ({
  queueClient: {
    getQueue: jest.fn(() => ({
      add: jest.fn().mockResolvedValue({ id: 'job-123' }),
    })),
    closeAll: jest.fn().mockResolvedValue(undefined),
  },
}));

import { swapService } from '@/infrastructure/external/jupiter/index.js';

describe('TradingExecutor Integration', () => {
  let prisma: ReturnType<typeof getTestPrisma>;
  let redis: ReturnType<typeof getTestRedis>;
  let testUserId: string;
  let testAgentId: string;
  let testWalletAddress: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    redis = getTestRedis();
    await connectTestRedis();
    await redisService.connect();
  });

  beforeEach(async () => {
    await cleanupTestDatabase(prisma);
    await cleanupTestRedis(redis);
    jest.clearAllMocks();

    testUserId = randomUUID();
    testAgentId = randomUUID();
    testWalletAddress = `test-wallet-${randomUUID().substring(0, 32)}`.substring(0, 44);

    // Seed: user, agent (simulation), wallet, SOL balance
    await prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: testUserId,
          email: `test-${testUserId}@example.com`,
          passwordHash: 'hash',
        },
      });

      await tx.agent.create({
        data: {
          id: testAgentId,
          userId: testUserId,
          name: 'Test Agent',
          tradingMode: 'simulation',
        },
      });

      await tx.agentWallet.create({
        data: {
          walletAddress: testWalletAddress,
          agentId: testAgentId,
          walletType: 'simulation',
        },
      });

      // SOL balance: 10 SOL (stored as string)
      await tx.agentBalance.create({
        data: {
          agentId: testAgentId,
          walletAddress: testWalletAddress,
          tokenAddress: SOL_MINT,
          tokenSymbol: 'SOL',
          balance: '10',
        },
      });
    });

    // Swap mocks: 1 SOL -> 1_000_000 token units (1 token at 6 decimals)
    const mockQuote = {
      requestId: 'quote-1',
      inputAmount: POSITION_SIZE_LAMPORTS,
      outputAmount: 1_000_000,
      priceImpact: 0.01,
      slippageBps: 50,
      transaction: null,
    };

    const mockSwapResult = {
      success: true,
      transactionHash: null,
      inputAmount: POSITION_SIZE_LAMPORTS,
      outputAmount: 1_000_000,
      totalInputAmount: POSITION_SIZE_LAMPORTS,
      actualPrice: 1,
      fees: 0,
      slippage: 0.005,
      priceImpact: 0.01,
      swapPayload: { swapUsdValue: 100 },
    };

    (swapService.getQuote as jest.Mock).mockResolvedValue(mockQuote);
    (swapService.executeSwap as jest.Mock).mockResolvedValue(mockSwapResult);
  });

  afterAll(async () => {
    await redisService.disconnect();
    await disconnectTestDatabase();
    await disconnectTestRedis();
  });

  describe('executePurchase', () => {
    it('should create position and transaction in DB with correct Decimal arithmetic', async () => {
      const result = await tradingExecutor.executePurchase({
        agentId: testAgentId,
        walletAddress: testWalletAddress,
        tokenAddress: TEST_TOKEN,
        tokenSymbol: 'TEST',
        positionSize: POSITION_SIZE_SOL,
      });

      expect(result.success).toBe(true);
      expect(result.transactionId).toBeDefined();
      expect(result.positionId).toBeDefined();
      expect(result.inputAmount).toBe(1);
      expect(result.outputAmount).toBe(1);
      expect(result.purchasePrice).toBe(1);

      // Position in DB
      const position = await prisma.agentPosition.findUnique({
        where: { id: result.positionId! },
      });
      expect(position).toBeDefined();
      expect(position!.agentId).toBe(testAgentId);
      expect(position!.walletAddress).toBe(testWalletAddress);
      expect(position!.tokenAddress).toBe(TEST_TOKEN);
      expect(position!.tokenSymbol).toBe('TEST');
      expect(new Decimal(position!.purchasePrice).toNumber()).toBe(1);
      expect(new Decimal(position!.purchaseAmount).toNumber()).toBe(1);

      // Transaction in DB
      const transaction = await prisma.agentTransaction.findUnique({
        where: { id: result.transactionId },
      });
      expect(transaction).toBeDefined();
      expect(transaction!.agentId).toBe(testAgentId);
      expect(transaction!.transactionType).toBe(TransactionType.SWAP);
      expect(new Decimal(transaction!.inputAmount!).toNumber()).toBe(1);
      expect(new Decimal(transaction!.outputAmount!).toNumber()).toBe(1);

      // Note: WRITE_HISTORICAL_SWAP is enqueued only on sale, not purchase
    });

    it('should debit SOL and credit token balances correctly', async () => {
      const initialSolBalance = await prisma.agentBalance.findUnique({
        where: {
          walletAddress_tokenAddress: {
            walletAddress: testWalletAddress,
            tokenAddress: SOL_MINT,
          },
        },
      });
      expect(initialSolBalance).toBeDefined();
      const initialSol = parseFloat(initialSolBalance!.balance);

      await tradingExecutor.executePurchase({
        agentId: testAgentId,
        walletAddress: testWalletAddress,
        tokenAddress: TEST_TOKEN,
        tokenSymbol: 'TEST',
        positionSize: POSITION_SIZE_SOL,
      });

      // SOL should be debited by ~1
      const afterSolBalance = await prisma.agentBalance.findUnique({
        where: {
          walletAddress_tokenAddress: {
            walletAddress: testWalletAddress,
            tokenAddress: SOL_MINT,
          },
        },
      });
      const afterSol = parseFloat(afterSolBalance!.balance);
      expect(afterSol).toBeLessThan(initialSol);
      expect(initialSol - afterSol).toBeCloseTo(1, 5);

      // Token balance should exist
      const tokenBalance = await prisma.agentBalance.findUnique({
        where: {
          walletAddress_tokenAddress: {
            walletAddress: testWalletAddress,
            tokenAddress: TEST_TOKEN,
          },
        },
      });
      expect(tokenBalance).toBeDefined();
      expect(parseFloat(tokenBalance!.balance)).toBeCloseTo(1, 5);
    });
  });
});
