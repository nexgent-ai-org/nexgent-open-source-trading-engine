/**
 * List agent balances endpoint
 * 
 * GET /api/agent-balances?agentId=:agentId
 * 
 * Returns all balances for a specific agent with enriched price information.
 * Ensures the agent belongs to the authenticated user.
 */

import { Response } from 'express';
import { prisma } from '@/infrastructure/database/client.js';
import type { AuthenticatedRequest } from '@/middleware/auth.js';
import { priceFeedService } from '@/infrastructure/external/dexscreener/index.js';
import { redisPriceService } from '@/infrastructure/cache/redis-price-service.js';
import type { AgentBalanceResponse } from '../types.js';

// SOL mint address constant
const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

/**
 * Get all balances for an agent
 * 
 * Query: { agentId: string }
 * Returns: Array of { id, agentId, tokenAddress, tokenSymbol, balance, lastUpdated }
 */
export async function listAgentBalances(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const { agentId, walletAddress } = req.query;

    // Validate agentId
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({
        error: 'agentId query parameter is required',
      });
    }

    // Validate agentId format (UUID)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(agentId)) {
      return res.status(400).json({
        error: 'Invalid agent ID format',
      });
    }

    // Verify agent exists and belongs to the authenticated user
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId: req.user.id, // Ensure user can only access balances for their own agents
      },
    });

    if (!agent) {
      return res.status(404).json({
        error: 'Agent not found',
      });
    }

    // Build where clause - balances are per-wallet, so filter by walletAddress if provided
    const where: { agentId: string; walletAddress?: string } = {
      agentId,
    };

    // If walletAddress is provided, filter by it (balances are per-wallet)
    if (walletAddress && typeof walletAddress === 'string') {
      where.walletAddress = walletAddress;
    }

    // Get all balances for the agent (and wallet if specified)
    const balances = await prisma.agentBalance.findMany({
      where,
      select: {
        id: true,
        agentId: true,
        walletAddress: true,
        tokenAddress: true,
        tokenSymbol: true,
        balance: true,
        lastUpdated: true,
      },
      orderBy: {
        lastUpdated: 'desc', // Most recently updated first
      },
    });

    // Enrich balances with price information using cache-first approach
    const priceMap = new Map<string, number>(); // tokenAddress -> priceSol
    
    if (balances.length > 0) {
      // Collect unique token addresses, keeping the original casing alongside the
      // normalized form. Cache keys and lookups use the normalized address, but
      // the price API is case-sensitive on mints and needs the original.
      const addressCasing = new Map<string, string>();
      for (const balance of balances) {
        const normalized = balance.tokenAddress.toLowerCase();
        if (!addressCasing.has(normalized)) {
          addressCasing.set(normalized, balance.tokenAddress);
        }
      }
      const tokenAddresses = [...addressCasing.keys()];
      const startTime = Date.now();

      // Step 1: Try to get all prices from Redis cache (FAST - no network call)
      const cachedPrices = await redisPriceService.getMultiplePrices(tokenAddresses);
      const missingTokens: string[] = [];
      
      for (const [address, cached] of cachedPrices.entries()) {
        if (cached && cached.priceSol > 0) {
          priceMap.set(address.toLowerCase(), cached.priceSol);
        } else {
          missingTokens.push(address);
        }
      }

      const cacheHits = tokenAddresses.length - missingTokens.length;
      if (cacheHits > 0) {
        console.log(`[AgentBalances] ⚡ Redis cache: ${cacheHits}/${tokenAddresses.length} prices found in ${Date.now() - startTime}ms`);
      }

      // Step 2: Only call price API for tokens not in cache (should be rare after warmup)
      if (missingTokens.length > 0) {
        try {
          console.log(`[AgentBalances] 🌐 Fetching ${missingTokens.length} missing prices from API...`);
          const prices = await priceFeedService.getMultipleTokenPrices(
            missingTokens.map(address => addressCasing.get(address) ?? address)
          );
          for (const price of prices) {
            priceMap.set(price.tokenAddress.toLowerCase(), price.priceSol);
          }
          console.log(`[AgentBalances] ✅ Fetched ${prices.length} prices from API in ${Date.now() - startTime}ms`);
        } catch (priceError) {
          console.warn('[AgentBalances] Failed to fetch missing prices from API:', priceError);
          // Continue without prices for missing tokens - they'll show as undefined priceSol
        }
      }

      // Step 3: For SOL, price is always 1 SOL per SOL
      priceMap.set(SOL_MINT_ADDRESS.toLowerCase(), 1);
    }

    // Build response with enriched price information
    const response: AgentBalanceResponse[] = balances.map((balance) => {
      const tokenAddressLower = balance.tokenAddress.toLowerCase();
      const priceSol = priceMap.get(tokenAddressLower);

      return {
        id: balance.id,
        agentId: balance.agentId,
        walletAddress: balance.walletAddress,
        tokenAddress: balance.tokenAddress,
        tokenSymbol: balance.tokenSymbol,
        balance: balance.balance,
        lastUpdated: balance.lastUpdated,
        priceSol, // Optional: undefined if price not available
      };
    });

    res.json(response);
  } catch (error) {
    console.error('List agent balances error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
}

