/**
 * Get current SOL/USD price endpoint
 * 
 * GET /api/price-feeds/sol-usd
 * 
 * Returns current SOL/USD price from in-memory storage.
 * Requires authentication.
 */

import { Response } from 'express';
import { SolPriceService } from '@/infrastructure/external/jupiter/price/sol-price-service.js';
import type { AuthenticatedRequest } from '@/middleware/auth.js';

/**
 * Get current SOL/USD price
 * 
 * Returns: { price, lastUpdated, isStale, source }
 */
export async function getSolUsdPrice(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const priceService = SolPriceService.getInstance();
    const price = priceService.getSolPrice();
    const lastUpdated = priceService.getLastUpdated();
    const isStale = priceService.isPriceStale();

    res.json({
      price: price !== null ? price.toFixed(8) : null, // String for precision, null when unknown
      lastUpdated: lastUpdated?.toISOString() || null,
      isStale,
      healthy: priceService.isHealthy(),
      source: 'jupiter',
    });
  } catch (error) {
    console.error('Get price error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
}

