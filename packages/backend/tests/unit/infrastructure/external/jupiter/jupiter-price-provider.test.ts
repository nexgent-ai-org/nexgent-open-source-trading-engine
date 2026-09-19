/**
 * Jupiter Price Provider Unit Tests
 *
 * Focused on SOL handling in outgoing requests. Jupiter is case-sensitive on
 * mint addresses - a lowercased SOL mint returns {} rather than a price - while
 * callers legitimately pass normalized (lowercase) addresses. Getting this
 * wrong means the SOL/USD conversion rate is missing from the response and the
 * whole batch is discarded, which is exactly what happened in production.
 */

import { JupiterPriceProvider } from '@/infrastructure/external/jupiter/price/jupiter-price-provider.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

jest.mock('@/infrastructure/external/jupiter/price/sol-price-service.js', () => ({
  SolPriceService: {
    getInstance: jest.fn(() => ({
      updateFromPoll: jest.fn(),
    })),
  },
  SOL_MINT: 'So11111111111111111111111111111111111111112',
}));

/**
 * Capture the ids parameter of each outgoing request and reply with a priced
 * entry for every id that was asked for in canonical casing.
 */
function mockJupiter(requestedIds: string[][]) {
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    const ids = new URL(String(url)).searchParams.get('ids') ?? '';
    const list = ids.split(',').filter(Boolean);
    requestedIds.push(list);

    const body: Record<string, unknown> = {};
    for (const id of list) {
      // Jupiter only returns entries for exactly-matching (canonical) mints
      if (id === SOL_MINT || id === BONK) {
        body[id] = { usdPrice: id === SOL_MINT ? 100 : 0.5, blockId: 1, decimals: 9, priceChange24h: 0 };
      }
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('JupiterPriceProvider', () => {
  let requestedIds: string[][];
  let provider: JupiterPriceProvider;

  beforeEach(() => {
    requestedIds = [];
    mockJupiter(requestedIds);
    provider = new JupiterPriceProvider();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getMultipleTokenPrices', () => {
    it('requests SOL in canonical casing when the caller passes it lowercased', async () => {
      await provider.getMultipleTokenPrices([SOL_MINT.toLowerCase()]);

      expect(requestedIds).toHaveLength(1);
      expect(requestedIds[0]).toContain(SOL_MINT);
      expect(requestedIds[0]).not.toContain(SOL_MINT.toLowerCase());
    });

    it('does not request SOL twice when the caller already passes it canonically', async () => {
      await provider.getMultipleTokenPrices([SOL_MINT, BONK]);

      const solOccurrences = requestedIds[0].filter(
        id => id.toLowerCase() === SOL_MINT.toLowerCase()
      );
      expect(solOccurrences).toHaveLength(1);
    });

    it('appends SOL to a batch that does not include it', async () => {
      await provider.getMultipleTokenPrices([BONK]);

      expect(requestedIds[0]).toContain(BONK);
      expect(requestedIds[0]).toContain(SOL_MINT);
    });

    it('still prices a token when the caller lowercased the SOL mint', async () => {
      // The production failure: a lowercase SOL mint meant no SOL in the
      // response, so the conversion rate was missing and the batch was dropped.
      const results = await provider.getMultipleTokenPrices([SOL_MINT.toLowerCase()]);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].priceUsd).toBe(100);
      expect(results[0].priceSol).toBe(1); // SOL priced in SOL
    });

    it('converts token prices using the SOL rate from the same response', async () => {
      const results = await provider.getMultipleTokenPrices([BONK]);
      const bonk = results.find(r => r.tokenAddress === BONK.toLowerCase());

      expect(bonk).toBeDefined();
      expect(bonk!.priceUsd).toBe(0.5);
      expect(bonk!.priceSol).toBe(0.005); // 0.5 USD / 100 USD-per-SOL
    });

    it('returns an empty array for an empty request without calling the API', async () => {
      const results = await provider.getMultipleTokenPrices([]);

      expect(results).toEqual([]);
      expect(requestedIds).toHaveLength(0);
    });
  });
});
