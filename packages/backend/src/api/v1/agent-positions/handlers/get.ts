/**
 * Get agent positions endpoint
 * 
 * GET /api/v1/agent-positions/:agentId
 * 
 * Returns all positions for an agent with enriched data (current prices, P/L, etc.).
 * Optionally filtered by walletAddress query parameter.
 */

import { Response } from 'express';
import { prisma } from '@/infrastructure/database/client.js';
import type { AuthenticatedRequest } from '@/middleware/auth.js';
import { positionService } from '@/domain/trading/position-service.js';
import { priceFeedService } from '@/infrastructure/external/dexscreener/index.js';
import { SolPriceService } from '@/infrastructure/external/jupiter/price/sol-price-service.js';
import type { PositionResponse } from '../types.js';
import type { OpenPosition } from '@nexgent/shared';

/**
 * Get all positions for an agent
 * 
 * Params: { id: string } (agent ID)
 * Query: { walletAddress?: string } (optional wallet filter)
 * Returns: Array of PositionResponse
 */
export async function getAgentPositions(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const { agentId } = req.params;
    const { walletAddress } = req.query;

    // Validate agent ID format (UUID)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(agentId)) {
      return res.status(400).json({
        error: 'Invalid agent ID format',
      });
    }

    // Validate wallet ID if provided
    if (walletAddress && typeof walletAddress === 'string') {
      return res.status(400).json({
        error: 'Invalid wallet ID format',
      });
    }

    // Verify agent belongs to authenticated user
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId: req.user.id,
      },
      select: {
        id: true,
      },
    });

    if (!agent) {
      return res.status(404).json({
        error: 'Agent not found',
      });
    }

    // Get all wallets for this agent (if walletAddress not specified, get all positions)
    let walletAddresses: string[] = [];
    if (walletAddress) {
      // Verify wallet belongs to agent
      const wallet = await prisma.agentWallet.findFirst({
        where: {
          walletAddress: walletAddress as string,
          agentId,
        },
        select: {
          walletAddress: true,
        },
      });

      if (!wallet) {
        return res.status(404).json({
          error: 'Wallet not found or does not belong to agent',
        });
      }

      walletAddresses = [walletAddress as string];
    } else {
      // Get all wallets for this agent
      const wallets = await prisma.agentWallet.findMany({
        where: {
          agentId,
        },
        select: {
          walletAddress: true,
        },
      });

      walletAddresses = wallets.map((w) => w.walletAddress);
    }

    // Load positions for all wallets
    const allPositions: OpenPosition[] = [];
    const tokenAddresses = new Set<string>();
    const transactionIds = new Set<string>();

    // First pass: Load all positions and collect unique token addresses and transaction IDs
    for (const wAddress of walletAddresses) {
      const walletPositions = await positionService.loadPositions(agentId, wAddress);
      
      for (const position of walletPositions) {
        allPositions.push(position);
        tokenAddresses.add(position.tokenAddress);
        transactionIds.add(position.purchaseTransactionId);
      }
    }

    // Batch fetch all transactions at once
    const transactionsMap = new Map<string, { id: string; transactionHash: string | null; transactionTime: Date }>();
    
    if (transactionIds.size > 0) {
      const transactions = await prisma.agentTransaction.findMany({
        where: {
          id: { in: Array.from(transactionIds) },
        },
        select: {
          id: true,
          transactionHash: true,
          transactionTime: true,
        },
      });

      for (const transaction of transactions) {
        transactionsMap.set(transaction.id, transaction);
      }
    }

    // Batch fetch all token prices at once (much more efficient)
    const tokenPricesMap = new Map<string, { priceSol: number; priceUsd: number }>();
    
    if (tokenAddresses.size > 0) {
      try {
        const prices = await priceFeedService.getMultipleTokenPrices(Array.from(tokenAddresses));
        for (const price of prices) {
          tokenPricesMap.set(price.tokenAddress.toLowerCase(), {
            priceSol: price.priceSol,
            priceUsd: price.priceUsd,
          });
        }
      } catch (error) {
        console.warn(
          'Failed to batch fetch token prices:',
          error instanceof Error ? error.message : String(error)
        );
        // Continue with fallback prices
      }
    }

    // Get SOL/USD price for conversions (used for all positions).
    // Throws if no trustworthy price is available - handled by the catch below,
    // which is preferable to rendering USD figures derived from a guess.
    const solPrice = await SolPriceService.getInstance().getSolPriceOrFetch();

    // Second pass: Enrich positions with prices
    const positions: PositionResponse[] = [];

    for (const position of allPositions) {
      // Get purchase transaction from batch fetch
      const transaction = transactionsMap.get(position.purchaseTransactionId);
      
      if (!transaction) {
        // Skip positions with missing transactions
        continue;
      }
      // Get current token price from batch fetch or use fallback
      let currentPrice = position.purchasePrice; // Fallback to purchase price
      let currentPriceUsd = 0;
      let priceChangePercent = 0;

      const cachedPrice = tokenPricesMap.get(position.tokenAddress.toLowerCase());
      if (cachedPrice) {
        currentPrice = cachedPrice.priceSol;
        currentPriceUsd = cachedPrice.priceUsd;
        priceChangePercent = position.purchasePrice > 0
          ? ((currentPrice - position.purchasePrice) / position.purchasePrice) * 100
          : 0;
      } else {
        // Price not found in batch (token might not exist anymore)
        // Use purchase price as fallback
        currentPriceUsd = position.purchasePrice * solPrice;
      }

        // Calculate USD values
        const purchasePriceUsd = position.purchasePrice * solPrice; // Estimated at purchase time
        const positionValueSol = currentPrice * position.purchaseAmount;
        const positionValueUsd = currentPriceUsd * position.purchaseAmount;
        const profitLossSol = positionValueSol - (position.purchasePrice * position.purchaseAmount);
        const profitLossUsd = positionValueUsd - (purchasePriceUsd * position.purchaseAmount);
        const profitLossPercent = purchasePriceUsd * position.purchaseAmount > 0
          ? (profitLossUsd / (purchasePriceUsd * position.purchaseAmount)) * 100
          : 0;

        // Calculate take-profit metrics
        const remainingAmount = position.remainingAmount ?? position.purchaseAmount;
        const soldAmount = position.purchaseAmount - remainingAmount;
        const soldPercent = position.purchaseAmount > 0 
          ? (soldAmount / position.purchaseAmount) * 100 
          : 0;

        const enrichedPosition: PositionResponse = {
          // Basic identification
          id: position.id,
          agentId: position.agentId,
          walletAddress: position.walletAddress,
          tokenAddress: position.tokenAddress,
          tokenSymbol: position.tokenSymbol,
          
          // Purchase information
          purchase: {
            priceNative: position.purchasePrice,
            priceUsd: purchasePriceUsd,
            amount: position.purchaseAmount,
            transaction: {
              id: transaction.id,
              hash: transaction.transactionHash || null,
              time: transaction.transactionTime,
            },
          },
          
          // Current market data
          current: {
            priceNative: currentPrice,
            priceUsd: currentPriceUsd,
            valueNative: positionValueSol,
            valueUsd: positionValueUsd,
          },
          
          // Profit/Loss metrics
          profitLoss: {
            native: profitLossSol,
            usd: profitLossUsd,
            percent: profitLossPercent,
            priceChangePercent: priceChangePercent,
          },
          
          // Stop loss information
          stopLoss: {
            percentage: position.currentStopLossPercentage ?? 0,
            peakPrice: position.peakPrice ?? 0,
          },
          
          // Take-profit information
          takeProfit: {
            levelsHit: position.takeProfitLevelsHit,
            totalLevels: position.totalTakeProfitLevels,
            tpBatchStartLevel: position.tpBatchStartLevel,
            remainingAmount: remainingAmount,
            originalAmount: position.purchaseAmount,
            soldPercent: soldPercent,
            moonBagActivated: position.moonBagActivated,
            moonBagAmount: position.moonBagAmount,
            lastTakeProfitTime: position.lastTakeProfitTime,
            transactionIds: position.takeProfitTransactionIds,
          },
          
          // DCA information
          dca: {
            count: position.dcaCount,
            totalInvestedSol: position.totalInvestedSol,
            lastDcaTime: position.lastDcaTime,
          },
          
          // Timestamps
          createdAt: position.createdAt,
          updatedAt: position.updatedAt,
        };

      positions.push(enrichedPosition);
    }

    // Sort by creation date (newest first)
    positions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    res.json(positions);
  } catch (error) {
    console.error('Get agent positions error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
}

