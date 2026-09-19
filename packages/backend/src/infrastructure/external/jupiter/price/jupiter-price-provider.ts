/**
 * Jupiter Price Provider
 * 
 * Implementation of price feed provider using Jupiter Price API V3
 * https://dev.jup.ag/docs/price/v3
 */

import { BasePriceProvider } from '../../dexscreener/base-price-provider.js';
import type { TokenPrice } from '../../dexscreener/types.js';
import { PriceFeedServiceError } from '../../dexscreener/types.js';
import { SolPriceService, SOL_MINT } from './sol-price-service.js';

/**
 * Jupiter API base URL
 *
 * Defaults to the keyed endpoint, matching the swap and token-metrics providers.
 * A Jupiter API key is required to run this project, and rate limits are applied
 * per organisation across Swap, Price and Token requests - so price requests
 * belong on the same plan as everything else rather than on the keyless bucket,
 * which allows only 30 requests/minute. Jupiter is also retiring lite-api.jup.ag.
 */
const JUPITER_API_BASE_URL = process.env.JUPITER_API_URL || 'https://api.jup.ag/price/v3';

/**
 * Maximum tokens per batch request
 */
const MAX_BATCH_SIZE = 50;

/**
 * Jupiter Price API V3 response structure
 */
interface JupiterPriceResponse {
  [tokenAddress: string]: {
    usdPrice: number;
    blockId: number;
    decimals: number;
    priceChange24h: number;
  };
}

/**
 * Jupiter Price Provider
 * 
 * Implements price feed functionality using Jupiter Price API V3
 * Note: Jupiter only provides USD prices, so we convert to SOL using the
 * SOL/USD price from the same response - SOL is requested alongside the
 * caller's tokens, so the conversion rate is always consistent with the token
 * prices it is applied to, and costs no extra request.
 */
export class JupiterPriceProvider extends BasePriceProvider {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(baseUrl?: string, apiKey?: string) {
    super();
    this.baseUrl = baseUrl || JUPITER_API_BASE_URL;
    this.apiKey = apiKey || process.env.JUPITER_API_KEY;
  }

  /**
   * Get the name of the provider
   */
  getName(): string {
    return 'jupiter';
  }

  /**
   * Extract SOL/USD from a Jupiter response and publish it to SolPriceService.
   *
   * SOL is included in every batch we send, so the rate used to convert token
   * prices comes from the same response as those prices. This also keeps the
   * app-wide SOL price fresh for free: no separate request is made.
   *
   * @param response - Jupiter API response that included SOL_MINT
   * @returns SOL price in USD, or null if absent from the response
   */
  private extractAndPublishSolUsdPrice(response: JupiterPriceResponse): number | null {
    const solData = response[SOL_MINT]
      ?? response[Object.keys(response).find(k => k.toLowerCase() === SOL_MINT.toLowerCase()) ?? ''];

    const priceUsd = solData?.usdPrice;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      return null;
    }

    SolPriceService.getInstance().updateFromPoll(priceUsd);
    return priceUsd;
  }

  /**
   * Ensure SOL is present in a batch of addresses, in its canonical casing.
   *
   * Jupiter is case-sensitive on mint addresses: a lowercased SOL mint returns
   * an empty object rather than a price. Callers legitimately pass normalized
   * (lowercase) addresses, so any case-variant of SOL is replaced with the
   * canonical form rather than being treated as already present.
   */
  private withSolMint(addresses: string[]): string[] {
    const withoutSol = addresses.filter(a => a.toLowerCase() !== SOL_MINT.toLowerCase());
    return [...withoutSol, SOL_MINT];
  }

  /**
   * Parse Jupiter response to TokenPrice
   * 
   * @param response - Jupiter API response
   * @param tokenAddress - Token address being queried (original case)
   * @param solUsdPrice - SOL/USD price for conversion
   * @returns TokenPrice or null if token not found
   */
  private parseTokenPrice(
    response: JupiterPriceResponse,
    tokenAddress: string,
    solUsdPrice: number
  ): TokenPrice | null {
    const normalizedAddress = tokenAddress.toLowerCase();
    const responseKeys = Object.keys(response);
    
    if (responseKeys.length === 0) {
      return null;
    }

    // Jupiter returns keys in original case, so we need to do case-insensitive lookup
    // First try exact match (most common case)
    let tokenData = response[tokenAddress];
    
    // If not found, try case-insensitive lookup
    if (!tokenData) {
      const matchingKey = responseKeys.find(
        key => key.toLowerCase() === normalizedAddress
      );
      if (matchingKey) {
        tokenData = response[matchingKey];
      } else {
        return null;
      }
    }

    if (!tokenData || !tokenData.usdPrice || tokenData.usdPrice <= 0) {
      return null;
    }

    // Convert USD price to SOL price
    const priceSol = tokenData.usdPrice / solUsdPrice;

    return {
      tokenAddress: normalizedAddress, // Normalize for storage
      priceSol,
      priceUsd: tokenData.usdPrice,
      liquidity: 0, // Jupiter doesn't provide liquidity data
      priceChange24h: tokenData.priceChange24h || 0,
      lastUpdated: new Date(),
      // pairAddress is not provided by Jupiter
    };
  }

  /**
   * Get price for a single token
   * 
   * @param tokenAddress - Token address to get price for
   * @returns Token price information
   * @throws PriceFeedServiceError if price fetch fails
   */
  async getTokenPrice(tokenAddress: string): Promise<TokenPrice> {
    this.validateTokenAddress(tokenAddress);

    // Request SOL alongside the token so the USD->SOL conversion rate comes
    // from the same response (and refreshes the app-wide SOL price for free).
    const ids = this.withSolMint([tokenAddress]).join(',');
    const url = `${this.baseUrl}?ids=${ids}`;

    try {
      const response = await this.executeWithRetry(async () => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        // Jupiter authenticates with a lowercase 'x-api-key' header, not a
        // bearer token - matching the swap and token-metrics providers.
        // Without it, requests fall back to the keyless tier's lower limit.
        if (this.apiKey) {
          headers['x-api-key'] = this.apiKey;
        }

        const res = await fetch(url, {
          method: 'GET',
          headers,
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => 'Unknown error');
          console.error(`[Jupiter] API error for ${tokenAddress}: ${res.status} ${res.statusText} - ${errorText}`);
          const error = new Error(`Jupiter API error: ${res.status} ${res.statusText} - ${errorText}`) as Error & { status: number };
          error.status = res.status;
          throw error;
        }

        return res;
      });

      // Get raw response text first for debugging
      const responseText = await response.text();
      let data: JupiterPriceResponse;
      try {
        data = JSON.parse(responseText) as JupiterPriceResponse;
      } catch (parseError) {
        console.error(`[Jupiter] Failed to parse JSON response:`, parseError);
        console.error(`[Jupiter] Full response text:`, responseText);
        throw new Error(`Invalid JSON response from Jupiter: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }

      // Get SOL/USD price for conversion, from this same response
      const solUsdPrice = this.extractAndPublishSolUsdPrice(data);
      if (solUsdPrice === null) {
        throw new PriceFeedServiceError(
          'Jupiter response did not include a usable SOL/USD price',
          'INVALID_SOL_PRICE',
          { tokenAddress }
        );
      }

      const tokenPrice = this.parseTokenPrice(data, tokenAddress, solUsdPrice);

      if (!tokenPrice) {
        throw new PriceFeedServiceError(
          `No price data found for token: ${tokenAddress}. Token may not have been traded in the last 7 days.`,
          'TOKEN_NOT_FOUND',
          { tokenAddress }
        );
      }

      return tokenPrice;
    } catch (error) {
      if (error instanceof PriceFeedServiceError) {
        throw error;
      }

      if (error instanceof Error) {
        throw new PriceFeedServiceError(
          `Failed to get price from Jupiter: ${error.message}`,
          'FETCH_FAILED',
          { tokenAddress, originalError: error.message }
        );
      }

      throw new PriceFeedServiceError(
        `Failed to get price from Jupiter: Unknown error`,
        'FETCH_FAILED',
        { tokenAddress }
      );
    }
  }

  /**
   * Get prices for multiple tokens
   * 
   * Uses Jupiter batch endpoint which supports up to 50 tokens per request.
   * 
   * @param tokenAddresses - Array of token addresses
   * @returns Array of token prices (may be fewer than requested if some fail)
   */
  async getMultipleTokenPrices(tokenAddresses: string[]): Promise<TokenPrice[]> {
    if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
      return [];
    }

    // Deduplicate addresses while preserving original case (Jupiter needs original case)
    // Use a Map to track original case for each normalized address
    const addressMap = new Map<string, string>();
    for (const addr of tokenAddresses) {
      const normalized = addr.toLowerCase();
      if (!addressMap.has(normalized)) {
        addressMap.set(normalized, addr); // Keep first occurrence's case
      }
    }
    const uniqueAddresses = Array.from(addressMap.values());
    const results: TokenPrice[] = [];

    // SOL/USD comes from the batch responses themselves. Carry the most recent
    // rate across batches so a later batch that somehow lacks SOL can still be
    // converted.
    let solUsdPrice: number | null = null;

    // Process in batches of 50 (Jupiter limit). MAX_BATCH_SIZE - 1 leaves room
    // for SOL, which is appended to every batch for the conversion rate.
    const chunkSize = MAX_BATCH_SIZE - 1;
    for (let i = 0; i < uniqueAddresses.length; i += chunkSize) {
      const batch = uniqueAddresses.slice(i, i + chunkSize);
      // Join addresses with commas - Jupiter expects comma-separated values
      // Don't encode the entire string, just join with commas
      const addressesString = this.withSolMint(batch).join(',');
      const url = `${this.baseUrl}?ids=${addressesString}`;

      try {
        const response = await this.executeWithRetry(async () => {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };

          // Jupiter authenticates with a lowercase 'x-api-key' header, not a
          // bearer token - matching the swap and token-metrics providers.
          // Without it, requests fall back to the keyless tier's lower limit.
          if (this.apiKey) {
            headers['x-api-key'] = this.apiKey;
          }

          const res = await fetch(url, {
            method: 'GET',
            headers,
          });

          if (!res.ok) {
            const errorText = await res.text().catch(() => 'Unknown error');
            const error = new Error(`Jupiter API error: ${res.status} ${res.statusText} - ${errorText}`) as Error & { status: number };
            error.status = res.status;
            throw error;
          }

          return res;
        });

        const responseText = await response.text();
        let data: JupiterPriceResponse;
        try {
          data = JSON.parse(responseText) as JupiterPriceResponse;
        } catch (parseError) {
          console.error(`[Jupiter] Failed to parse JSON response:`, parseError);
          console.error(`[Jupiter] Full response text:`, responseText);
          throw new Error(`Invalid JSON response from Jupiter: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        }

        // Refresh the conversion rate from this response
        solUsdPrice = this.extractAndPublishSolUsdPrice(data) ?? solUsdPrice;

        if (solUsdPrice === null) {
          console.error('[Jupiter] No SOL/USD price in response, cannot convert batch prices');
          continue;
        }

        // Process each token in the batch
        for (const address of batch) {
          const tokenPrice = this.parseTokenPrice(data, address, solUsdPrice);
          if (tokenPrice) {
            results.push(tokenPrice);
          }
        }
      } catch (error) {
        console.error(`[Jupiter] Batch fetch failed for batch starting at index ${i}:`, error);
        // Continue to next batch, don't fail everything
      }
    }

    return results;
  }
}

