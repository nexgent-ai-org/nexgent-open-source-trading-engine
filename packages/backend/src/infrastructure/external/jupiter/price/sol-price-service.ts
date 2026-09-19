/**
 * SOL Price Service
 *
 * Maintains the SOL/USD price used for USD valuation across the app.
 *
 * Price data comes from Jupiter Price API V3. In normal operation the value is
 * pushed in by PriceUpdateManager, which already polls Jupiter for tracked
 * position tokens - SOL simply rides along in that existing batch request, so
 * keeping this value fresh costs no additional API calls.
 *
 * When no positions are open, PriceUpdateManager falls back to a slower
 * SOL-only heartbeat. This service can also fetch on demand when a caller needs
 * a trustworthy price right now (see getSolPriceOrFetch).
 *
 * Design note: there is deliberately NO hardcoded fallback price. The previous
 * implementation defaulted to $100 and swallowed fetch errors, which meant an
 * upstream outage silently produced wrong USD figures instead of surfacing as
 * an error.
 */

import { redisPriceService } from '@/infrastructure/cache/redis-price-service.js';

/**
 * Wrapped SOL mint - Jupiter prices SOL under this address.
 */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Jupiter Price API V3 base URL (shared with JupiterPriceProvider).
 */
const JUPITER_API_BASE_URL = process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/price/v3';

/**
 * Age beyond which the in-memory price is considered stale.
 *
 * Sized against the idle heartbeat (30s) rather than the active poll interval
 * (1.5s), so an idle service with no open positions does not flap between
 * fresh and stale between heartbeats.
 */
const STALE_THRESHOLD_MS = 90_000;

/**
 * Timeout for an on-demand fetch. Kept short - callers are usually in the
 * middle of recording a trade and should not block for long.
 */
const FETCH_TIMEOUT_MS = 5_000;

type PriceSource = 'poll' | 'on-demand' | 'redis' | 'none';

/**
 * Thrown when a trustworthy SOL/USD price cannot be obtained.
 *
 * Callers that persist USD values should let this propagate rather than
 * substituting a guess - a loud failure is recoverable, a wrong number is not.
 */
export class SolPriceUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SolPriceUnavailableError';
  }
}

interface JupiterPriceResponse {
  [tokenAddress: string]: {
    usdPrice: number;
    blockId: number;
    decimals: number;
    priceChange24h: number;
  };
}

export class SolPriceService {
  private static instance: SolPriceService;

  private solPrice: number | null = null;
  private lastUpdated: Date | null = null;
  private source: PriceSource = 'none';
  private lastError: Error | null = null;
  private isInitialized = false;

  /** De-duplicates concurrent on-demand fetches into a single request. */
  private inFlightFetch: Promise<number> | null = null;

  private constructor() {}

  static getInstance(): SolPriceService {
    if (!SolPriceService.instance) {
      SolPriceService.instance = new SolPriceService();
    }
    return SolPriceService.instance;
  }

  /**
   * Initialize the service.
   *
   * Tries Redis first (a warm restart usually has a recent price cached), then
   * falls back to a direct fetch. Never throws: pricing being degraded should
   * not take the whole backend down, so startup continues and the unhealthy
   * state is exposed via isHealthy() and the price-feeds endpoint.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    console.log('📊 Initializing SOL price service (Jupiter)...');

    try {
      const cached = await redisPriceService.getPrice(SOL_MINT);
      if (cached?.priceUsd && cached.priceUsd > 0) {
        this.solPrice = cached.priceUsd;
        this.lastUpdated = cached.lastUpdated ? new Date(cached.lastUpdated) : new Date();
        this.source = 'redis';
        console.log(`💰 SOL price primed from cache: $${this.solPrice.toFixed(2)}`);
      }
    } catch (error) {
      // Cache miss or Redis unavailable is not fatal - we fetch below.
      console.warn('⚠️  Could not read cached SOL price:', error);
    }

    if (this.solPrice === null || this.isPriceStale()) {
      try {
        await this.fetchNow();
      } catch (error) {
        console.error(
          '❌ SOL price unavailable at startup - USD values will fail loudly until a price is obtained:',
          error
        );
      }
    }

    this.isInitialized = true;

    if (this.isHealthy()) {
      console.log('✅ SOL price service initialized');
    } else {
      console.warn('⚠️  SOL price service initialized WITHOUT a price (degraded)');
    }
  }

  /**
   * Last known SOL/USD price, or null if none has ever been obtained.
   *
   * Does not consider staleness - use isPriceStale() alongside it. Intended for
   * display paths (WebSocket broadcasts, read APIs) that can tolerate a slightly
   * old value and render "unavailable" for null. Anything persisting a USD
   * figure should use getSolPriceOrFetch() instead.
   */
  getSolPrice(): number | null {
    return this.solPrice;
  }

  /**
   * SOL/USD price guaranteed to be present and reasonably fresh.
   *
   * Returns the cached value when fresh; otherwise fetches on demand. Throws
   * SolPriceUnavailableError if no trustworthy price can be obtained, so
   * callers never persist a fabricated number.
   */
  async getSolPriceOrFetch(): Promise<number> {
    if (this.solPrice !== null && !this.isPriceStale()) {
      return this.solPrice;
    }

    try {
      return await this.fetchNow();
    } catch (error) {
      throw new SolPriceUnavailableError(
        'No trustworthy SOL/USD price available; refusing to record a USD value',
        error
      );
    }
  }

  /**
   * Record a price observed by the regular Jupiter poll.
   *
   * Called by PriceUpdateManager when SOL appears in a batch response, which is
   * the normal path - no extra request is made on our behalf.
   */
  updateFromPoll(priceUsd: number): void {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      return;
    }

    this.solPrice = priceUsd;
    this.lastUpdated = new Date();
    this.source = 'poll';
    this.lastError = null;
  }

  getLastUpdated(): Date | null {
    return this.lastUpdated;
  }

  getSource(): PriceSource {
    return this.source;
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  /**
   * Whether the service holds a usable, reasonably fresh price.
   */
  isHealthy(): boolean {
    return this.solPrice !== null && !this.isPriceStale();
  }

  /**
   * Whether the held price is older than the staleness threshold.
   * Returns true when no price has ever been obtained.
   */
  isPriceStale(): boolean {
    if (!this.lastUpdated || this.solPrice === null) {
      return true;
    }
    return Date.now() - this.lastUpdated.getTime() > STALE_THRESHOLD_MS;
  }

  /**
   * Fetch SOL/USD directly from Jupiter.
   *
   * Concurrent callers share a single in-flight request so a burst of trades
   * cannot fan out into a burst of API calls.
   */
  private async fetchNow(): Promise<number> {
    if (this.inFlightFetch) {
      return this.inFlightFetch;
    }

    this.inFlightFetch = this.doFetch().finally(() => {
      this.inFlightFetch = null;
    });

    return this.inFlightFetch;
  }

  private async doFetch(): Promise<number> {
    const url = `${JUPITER_API_BASE_URL}?ids=${SOL_MINT}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Pro tier key, when configured - same variable JupiterPriceProvider uses.
    if (process.env.JUPITER_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.JUPITER_API_KEY}`;
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as JupiterPriceResponse;
      const priceUsd = data[SOL_MINT]?.usdPrice;

      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        throw new Error('Jupiter returned no usable SOL/USD price');
      }

      this.solPrice = priceUsd;
      this.lastUpdated = new Date();
      this.source = 'on-demand';
      this.lastError = null;

      console.log(`💰 SOL price updated: $${priceUsd.toFixed(2)} SOL/USD (on-demand)`);
      return priceUsd;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      console.error('❌ Error fetching SOL price from Jupiter:', error);
      throw this.lastError;
    }
  }

  /**
   * Reset state. Polling is owned by PriceUpdateManager, so there is nothing to
   * tear down here beyond the cached value.
   */
  shutdown(): void {
    this.isInitialized = false;
    this.inFlightFetch = null;
    console.log('👋 SOL price service shutdown');
  }
}
