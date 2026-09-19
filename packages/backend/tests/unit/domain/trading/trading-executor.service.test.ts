/**
 * Trading Executor Service Unit Tests
 * 
 * Tests trade execution orchestration logic with mocked dependencies.
 */

import { TradingExecutor, TradingExecutorError } from '@/domain/trading/trading-executor.service.js';
import { createMockConfig } from '../../../helpers/test-factory.js';
import type { AgentTradingConfig } from '@nexgent/shared';
import { Decimal } from '@prisma/client/runtime/library';

// Mock all dependencies
jest.mock('@/domain/trading/trade-validator.service.js', () => {
  // Define TradeValidatorError inside the mock factory
  class TradeValidatorError extends Error {
    constructor(
      message: string,
      public readonly code?: string,
      public readonly details?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'TradeValidatorError';
    }
  }
  
  return {
    tradeValidator: {
      validateTradeExecution: jest.fn(),
    },
    TradeValidatorError,
  };
});

jest.mock('@/domain/trading/position-calculator.service.js', () => ({
  positionCalculator: {
    calculatePositionSize: jest.fn(),
  },
}));

jest.mock('@/infrastructure/external/dexscreener/index.js', () => ({
  priceFeedService: {
    getPrice: jest.fn(),
    getTokenPrice: jest.fn(),
  },
}));

jest.mock('@/infrastructure/external/jupiter/index.js', () => ({
  swapService: {
    getQuote: jest.fn(),
    executeSwap: jest.fn(),
  },
  SOL_MINT_ADDRESS: 'So11111111111111111111111111111111111111112',
}));

jest.mock('@/domain/balances/index.js', () => ({
  balanceService: {
    calculateBalanceDelta: jest.fn(),
    upsertBalance: jest.fn(),
    updateBalancesFromTransaction: jest.fn(),
  },
}));

jest.mock('@/domain/trading/position-service.js', () => ({
  positionService: {
    createPosition: jest.fn(),
    getPositionById: jest.fn(),
    closePosition: jest.fn(),
  },
}));

jest.mock('@/domain/trading/stop-loss-manager.service.js', () => ({
  stopLossManager: {
    initializeStopLoss: jest.fn(),
  },
}));

jest.mock('@/infrastructure/cache/redis-balance-service.js', () => ({
  redisBalanceService: {
    invalidateAgentBalances: jest.fn(),
    invalidateWalletBalances: jest.fn(),
    invalidateBalance: jest.fn(),
    setBalance: jest.fn(),
  },
}));

jest.mock('@/infrastructure/cache/redis-position-service.js', () => ({
  redisPositionService: {
    invalidateAgentPositions: jest.fn(),
    deletePosition: jest.fn(),
    setPosition: jest.fn(),
  },
}));

jest.mock('@/infrastructure/cache/idempotency-service.js', () => ({
  idempotencyService: {
    checkAndSet: jest.fn().mockResolvedValue(true), // Default: allow operations to proceed
    clear: jest.fn(),
    isInProgress: jest.fn().mockResolvedValue(false),
  },
}));

jest.mock('@/infrastructure/external/solana/token-metadata-service.js', () => ({
  tokenMetadataService: {
    getTokenDecimals: jest.fn(),
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

jest.mock('@/domain/trading/position-events.js', () => ({
  positionEventEmitter: {
    emit: jest.fn(),
    emitPositionClosed: jest.fn(),
  },
}));

jest.mock('@/infrastructure/queue/queue-client.js', () => ({
  queueClient: {
    getQueue: jest.fn(() => ({
      add: jest.fn(),
    })),
  },
}));

// Create a mock transaction client that will be passed to the callback
const mockTxClient = {
  agentTransaction: {
    create: jest.fn(),
    findUnique: jest.fn(),
  },
  agentHistoricalSwap: {
    create: jest.fn(),
  },
  agentBalance: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  agentPosition: {
    delete: jest.fn().mockResolvedValue(undefined),
  },
};

jest.mock('@/infrastructure/database/client.js', () => ({
  prisma: {
    agentTransaction: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    agentHistoricalSwap: {
      create: jest.fn(),
    },
    agentBalance: {
      findUnique: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    agentPosition: {
      findUnique: jest.fn(),
    },
    // $transaction properly executes the callback with a mock tx client
    $transaction: jest.fn(async (callback) => {
      return await callback(mockTxClient);
    }),
  },
}));

jest.mock('@/infrastructure/database/repositories/agent.repository.js', () => ({
  AgentRepository: jest.fn().mockImplementation(() => ({
    findById: jest.fn(),
    findWalletByAddress: jest.fn(),
    findWalletByAgentId: jest.fn(),
  })),
}));

jest.mock('@/infrastructure/database/repositories/position.repository.js', () => ({
  PositionRepository: jest.fn().mockImplementation(() => ({
    findById: jest.fn(),
  })),
}));

jest.mock('@/infrastructure/database/repositories/transaction.repository.js', () => ({
  TransactionRepository: jest.fn().mockImplementation(() => ({
    create: jest.fn(),
  })),
}));

// Mock logger
jest.mock('@/infrastructure/logging/logger.js', () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
  return {
    __esModule: true,
    default: mockLogger,
    logger: mockLogger,
  };
});

// Mock metrics
jest.mock('@/infrastructure/metrics/metrics.js', () => ({
  tradeExecutionLatency: {
    observe: jest.fn(),
  },
  tradeExecutionCount: {
    inc: jest.fn(),
  },
  errorCount: {
    inc: jest.fn(),
  },
}));

// Mock timeout utility
jest.mock('@/shared/utils/timeout.js', () => ({
  withTimeout: jest.fn((promise) => promise),
  API_TIMEOUTS: {
    TOKEN_METADATA: 5000,
    SWAP_QUOTE: 10000,
  },
}));

describe('TradingExecutor', () => {
  let tradingExecutor: TradingExecutor;
  let mockAgentRepo: any;
  let mockPositionRepo: any;
  let mockTransactionRepo: any;
  let mockTradeValidator: any;
  let mockSwapService: any;
  let mockBalanceService: any;
  let mockPositionService: any;
  let mockStopLossManager: any;
  let mockTokenMetadataService: any;
  let mockPriceFeedService: any;
  let mockAgentRepoInstance: any;
  let mockPositionRepoInstance: any;
  let mockTransactionRepoInstance: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Get mocked modules
    const tradeValidatorModule = await import('@/domain/trading/trade-validator.service.js');
    mockTradeValidator = tradeValidatorModule.tradeValidator;

    const swapServiceModule = await import('@/infrastructure/external/jupiter/index.js');
    mockSwapService = swapServiceModule.swapService;

    const balanceServiceModule = await import('@/domain/balances/index.js');
    mockBalanceService = balanceServiceModule.balanceService;

    const positionServiceModule = await import('@/domain/trading/position-service.js');
    mockPositionService = positionServiceModule.positionService;

    const stopLossManagerModule = await import('@/domain/trading/stop-loss-manager.service.js');
    mockStopLossManager = stopLossManagerModule.stopLossManager;

    const tokenMetadataModule = await import('@/infrastructure/external/solana/token-metadata-service.js');
    mockTokenMetadataService = tokenMetadataModule.tokenMetadataService;

    const priceFeedModule = await import('@/infrastructure/external/dexscreener/index.js');
    mockPriceFeedService = priceFeedModule.priceFeedService;

    // Create mock repository instances
    const { AgentRepository } = await import('@/infrastructure/database/repositories/agent.repository.js');
    const { PositionRepository } = await import('@/infrastructure/database/repositories/position.repository.js');
    const { TransactionRepository } = await import('@/infrastructure/database/repositories/transaction.repository.js');

    mockAgentRepoInstance = new AgentRepository();
    mockPositionRepoInstance = new PositionRepository();
    mockTransactionRepoInstance = new TransactionRepository();

    // Create executor instance
    tradingExecutor = new TradingExecutor(
      mockAgentRepoInstance,
      mockPositionRepoInstance,
      mockTransactionRepoInstance
    );
  });

  describe('executePurchase', () => {
    const mockRequest = {
      agentId: 'agent-123',
      walletAddress: 'test-wallet-address',
      tokenAddress: 'Token1111111111111111111111111111111111111111',
      tokenSymbol: 'TEST',
      positionSize: 1.0,
    };

    const mockConfig = createMockConfig();
    const mockWallet = {
      walletAddress: 'test-wallet-address',
      walletType: 'simulation' as const,
      agentId: 'agent-123',
    };

    it('should execute purchase successfully in simulation mode', async () => {
      // Arrange
      const mockValidation = {
        valid: true,
        config: mockConfig,
        currentSolBalance: new Decimal(10),
        positionSize: 1.0,
      };

      const mockSwapQuote = {
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'Token1111111111111111111111111111111111111111',
        inAmount: '1000000000', // 1 SOL
        outAmount: '1000000000', // 1 Token
        priceImpactPct: 0.1,
        slippageBps: 50,
        routes: [],
      };

      const mockSwapResult = {
        success: true,
        transactionHash: null,
        inputAmount: 1000000000, // 1 Token in smallest units
        outputAmount: 1000000000, // 1 SOL in lamports
        actualPrice: 1.0,
        fees: 0,
        slippage: 0.5,
        priceImpact: 0.1,
        routes: [],
      };

      const mockTransaction = {
        id: 'tx-123',
        agentId: 'agent-123',
        walletAddress: 'test-wallet-address',
        transactionType: 'SWAP' as const,
        transactionValueUsd: 100,
        transactionTime: new Date(),
        outputMint: 'Token1111111111111111111111111111111111111111',
      };

      const mockPosition = {
        id: 'position-123',
        agentId: 'agent-123',
        walletAddress: 'test-wallet-address',
        tokenAddress: 'Token1111111111111111111111111111111111111111',
        purchasePrice: 1.0,
        purchaseAmount: 1.0,
      };

      mockTradeValidator.validateTradeExecution.mockResolvedValue(mockValidation);
      mockAgentRepoInstance.findWalletByAddress.mockResolvedValue(mockWallet);
      mockTokenMetadataService.getTokenDecimals.mockResolvedValue(9);
      mockSwapService.getQuote.mockResolvedValue(mockSwapQuote);
      mockSwapService.executeSwap.mockResolvedValue(mockSwapResult);
      mockBalanceService.calculateBalanceDelta.mockReturnValue({
        inputToken: {
          tokenAddress: 'So11111111111111111111111111111111111111112',
          tokenSymbol: 'SOL',
          delta: new Decimal(-1),
          requiresValidation: true,
          mustExist: true,
        },
        outputToken: {
          tokenAddress: 'Token1111111111111111111111111111111111111111',
          tokenSymbol: 'TEST',
          delta: new Decimal(1),
          requiresValidation: false,
          mustExist: false,
        },
      });
      mockBalanceService.upsertBalance.mockResolvedValue(undefined);
      mockBalanceService.updateBalancesFromTransaction.mockResolvedValue(undefined);
      mockPositionService.createPosition.mockResolvedValue(mockPosition);
      mockStopLossManager.initializeStopLoss.mockResolvedValue(-32);

      // Mock transaction repo create - this is what's actually used in the code
      mockTransactionRepoInstance.create.mockResolvedValue(mockTransaction);

      // Mock prisma.agentPosition.findUnique to return the position (needed for stop loss init)
      const { prisma } = await import('@/infrastructure/database/client.js');
      (prisma.agentPosition.findUnique as jest.Mock).mockResolvedValue({
        ...mockPosition,
        purchasePrice: new Decimal(1.0),
        purchaseAmount: new Decimal(1.0),
      });

      // Act
      const result = await tradingExecutor.executePurchase(mockRequest);

      // Assert
      expect(result.success).toBe(true);
      expect(result.transactionId).toBeDefined();
      expect(result.positionId).toBe('position-123');
      expect(result.inputAmount).toBe(1.0);
      expect(result.outputAmount).toBe(1.0);
      expect(result.purchasePrice).toBe(1.0);
      expect(result.stopLossInitialized).toBe(true);
      expect(result.stopLossPercentage).toBe(-32);
      expect(mockTradeValidator.validateTradeExecution).toHaveBeenCalledWith(
        'agent-123',
        'test-wallet-address',
        mockRequest.tokenAddress,
        1.0
      );
      expect(mockSwapService.getQuote).toHaveBeenCalled();
      expect(mockPositionService.createPosition).toHaveBeenCalled();
    });

    it('should throw error when validation fails', async () => {
      // Arrange
      const mockValidation = {
        valid: false,
        error: 'Insufficient balance',
        errorCode: 'INSUFFICIENT_BALANCE',
      };

      mockTradeValidator.validateTradeExecution.mockResolvedValue(mockValidation);

      // Act & Assert (single call, two assertions)
      const p = tradingExecutor.executePurchase(mockRequest);
      await expect(p).rejects.toThrow(TradingExecutorError);
      await expect(p).rejects.toThrow('Insufficient balance');
    });

    it('should throw error when wallet not found', async () => {
      // Arrange
      const mockValidation = {
        valid: true,
        config: mockConfig,
        currentSolBalance: new Decimal(10),
        positionSize: 1.0,
      };

      mockTradeValidator.validateTradeExecution.mockResolvedValue(mockValidation);
      mockAgentRepoInstance.findWalletByAddress.mockResolvedValue(null);

      // Act & Assert (single call, two assertions)
      const p = tradingExecutor.executePurchase(mockRequest);
      await expect(p).rejects.toThrow(TradingExecutorError);
      await expect(p).rejects.toThrow('Wallet not found');
    });

    it('should throw error when swap quote fails', async () => {
      // Arrange
      const mockValidation = {
        valid: true,
        config: mockConfig,
        currentSolBalance: new Decimal(10),
        positionSize: 1.0,
      };

      mockTradeValidator.validateTradeExecution.mockResolvedValue(mockValidation);
      mockAgentRepoInstance.findWalletByAddress.mockResolvedValue(mockWallet);
      mockTokenMetadataService.getTokenDecimals.mockResolvedValue(9);
      mockSwapService.getQuote.mockRejectedValue(new Error('Swap quote failed'));

      // Act & Assert
      await expect(tradingExecutor.executePurchase(mockRequest)).rejects.toThrow();
    });

    it('should use default wallet when walletAddress not provided', async () => {
      // Arrange
      const requestWithoutWallet = {
        agentId: 'agent-123',
        tokenAddress: 'Token1111111111111111111111111111111111111111',
      };

      const mockValidation = {
        valid: true,
        config: mockConfig,
        currentSolBalance: new Decimal(10),
        positionSize: 1.0,
      };

      const mockAgent = {
        id: 'agent-123',
        tradingMode: 'simulation' as const,
      };
      mockAgentRepoInstance.findById.mockResolvedValue(mockAgent);
      mockAgentRepoInstance.findWalletByAgentId.mockResolvedValue(mockWallet);
      mockTradeValidator.validateTradeExecution.mockResolvedValue(mockValidation);
      mockAgentRepoInstance.findWalletByAddress.mockResolvedValue(mockWallet);
      mockTokenMetadataService.getTokenDecimals.mockResolvedValue(9);
      mockSwapService.getQuote.mockResolvedValue({
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'Token1111111111111111111111111111111111111111',
        inAmount: '1000000000',
        outAmount: '1000000000',
        priceImpactPct: 0.1,
        slippageBps: 50,
        routes: [],
      });
      mockSwapService.executeSwap.mockResolvedValue({
        success: true,
        transactionHash: null,
        inputAmount: 1.0,
        outputAmount: 1.0,
        actualPrice: 1.0,
        fees: 0,
        slippage: 0.5,
        priceImpact: 0.1,
        routes: [],
      });
      mockBalanceService.calculateBalanceDelta.mockReturnValue({
        inputToken: {
          tokenAddress: 'So11111111111111111111111111111111111111112',
          tokenSymbol: 'SOL',
          delta: new Decimal(-1),
          requiresValidation: true,
          mustExist: true,
        },
        outputToken: {
          tokenAddress: 'Token1111111111111111111111111111111111111111',
          tokenSymbol: 'TEST',
          delta: new Decimal(1),
          requiresValidation: false,
          mustExist: false,
        },
      });
      mockBalanceService.upsertBalance.mockResolvedValue(undefined);
      mockBalanceService.updateBalancesFromTransaction.mockResolvedValue(undefined);
      mockPositionService.createPosition.mockResolvedValue({
        id: 'position-123',
        agentId: 'agent-123',
        walletAddress: 'test-wallet-address',
        tokenAddress: 'Token1111111111111111111111111111111111111111',
        purchasePrice: 1.0,
        purchaseAmount: 1.0,
      });
      mockStopLossManager.initializeStopLoss.mockResolvedValue(-32);

      // Mock transaction repo create - this is what's actually used in the code
      mockTransactionRepoInstance.create.mockResolvedValue({
        id: 'tx-123',
        agentId: 'agent-123',
        walletAddress: 'test-wallet-address',
        transactionType: 'SWAP' as const,
        transactionValueUsd: 100,
        transactionTime: new Date(),
        outputMint: 'Token1111111111111111111111111111111111111111',
      });

      // Act
      const result = await tradingExecutor.executePurchase(requestWithoutWallet);

      // Assert
      expect(result.success).toBe(true);
      expect(mockAgentRepoInstance.findWalletByAgentId).toHaveBeenCalled();
    });
  });

  describe('executeSale', () => {
    const mockSaleRequest = {
      agentId: 'agent-123',
      positionId: 'position-123',
      walletAddress: 'test-wallet-address',
      reason: 'manual' as const,
    };

    it('should execute sale successfully', async () => {
      // Arrange
      const mockPosition = {
        id: 'position-123',
        agentId: 'agent-123',
        walletAddress: 'test-wallet-address',
        tokenAddress: 'Token1111111111111111111111111111111111111111',
        tokenSymbol: 'TEST',
        purchasePrice: 1.0,
        purchaseAmount: 1.0,
        purchaseTransactionId: 'tx-purchase-123',
      };

      const mockWallet = {
        walletAddress: 'test-wallet-address',
        walletType: 'simulation' as const,
        agentId: 'agent-123',
      };

      const mockSwapQuote = {
        inputMint: 'Token1111111111111111111111111111111111111111',
        outputMint: 'So11111111111111111111111111111111111111112',
        inAmount: '1000000000', // 1 Token
        outAmount: '1000000000', // 1 SOL
        priceImpactPct: 0.1,
        slippageBps: 50,
        routes: [],
      };

      const mockSwapResult = {
        success: true,
        transactionHash: null,
        inputAmount: 1000000000, // 1 Token in smallest units
        outputAmount: 1000000000, // 1 SOL in lamports
        actualPrice: 1.0,
        fees: 0,
        slippage: 0.5,
        priceImpact: 0.1,
        routes: [],
      };

      mockPositionService.getPositionById.mockResolvedValue(mockPosition);
      mockAgentRepoInstance.findWalletByAddress.mockResolvedValue(mockWallet);
      mockTokenMetadataService.getTokenDecimals.mockResolvedValue(9);
      mockPriceFeedService.getTokenPrice.mockResolvedValue({
        priceSol: 1.0,
        priceUsd: 100,
        priceChange24h: 0,
      });
      mockSwapService.getQuote.mockResolvedValue(mockSwapQuote);
      mockSwapService.executeSwap.mockResolvedValue(mockSwapResult);
      mockBalanceService.calculateBalanceDelta.mockReturnValue({
        inputToken: {
          tokenAddress: 'Token1111111111111111111111111111111111111111',
          tokenSymbol: 'TEST',
          delta: new Decimal(-1),
          requiresValidation: true,
          mustExist: true,
        },
        outputToken: {
          tokenAddress: 'So11111111111111111111111111111111111111112',
          tokenSymbol: 'SOL',
          delta: new Decimal(1),
          requiresValidation: false,
          mustExist: false,
        },
      });
      mockBalanceService.upsertBalance.mockResolvedValue(undefined);
      mockPositionService.closePosition.mockResolvedValue(undefined);

      const { prisma } = await import('@/infrastructure/database/client.js');
      (prisma.agentTransaction.create as jest.Mock).mockResolvedValue({
        id: 'tx-sale-123',
        agentId: 'agent-123',
        walletAddress: 'test-wallet-address',
        transactionType: 'SWAP' as const,
        transactionValueUsd: 100,
        transactionTime: new Date(),
        outputMint: 'So11111111111111111111111111111111111111112',
      });
      (prisma.agentHistoricalSwap.create as jest.Mock).mockResolvedValue({
        id: 'swap-123',
        agentId: 'agent-123',
        walletAddress: 'test-wallet-address',
        positionId: 'position-123',
        purchaseTransactionId: 'tx-purchase-123',
        saleTransactionId: 'tx-sale-123',
        tokenAddress: 'Token1111111111111111111111111111111111111111',
        tokenSymbol: 'TEST',
        inputAmount: new Decimal(1.0),
        outputAmount: new Decimal(1.0),
        purchasePrice: new Decimal(1.0),
        salePrice: new Decimal(1.0),
        profitLossSol: new Decimal(0),
        profitLossUsd: new Decimal(0),
        changePercent: new Decimal(0),
      });

      // Act
      const result = await tradingExecutor.executeSale(mockSaleRequest);

      // Assert
      expect(result.success).toBe(true);
      expect(result.transactionId).toBeDefined();
      expect(result.positionId).toBe('position-123');
      expect(result.inputAmount).toBe(1.0);
      expect(result.outputAmount).toBe(1.0);
      expect(result.salePrice).toBe(1.0);
      // Position is deleted directly via Prisma transaction, not via positionService.closePosition
      expect(mockTxClient.agentPosition.delete).toHaveBeenCalledWith({
        where: { id: 'position-123' },
      });
    });

    it('should throw error when position not found', async () => {
      // Arrange
      mockPositionService.getPositionById.mockResolvedValue(null);

      // Act & Assert (single call, two assertions)
      const p = tradingExecutor.executeSale(mockSaleRequest);
      await expect(p).rejects.toThrow(TradingExecutorError);
      await expect(p).rejects.toThrow('Position not found');
    });
  });
});

