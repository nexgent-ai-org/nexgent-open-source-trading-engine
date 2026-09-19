/**
 * Redis Keys Unit Tests
 *
 * Covers key normalization. Price keys in particular must not be
 * case-sensitive: the price poller writes using a normalized (lowercase)
 * address while several readers pass the original mixed-case mint, and a
 * case-sensitive key meant those reads silently missed the cache forever.
 */

import { REDIS_KEYS } from '@/shared/constants/redis-keys.js';

describe('REDIS_KEYS', () => {
  describe('PRICE', () => {
    // Wrapped SOL, whose canonical form is mixed case
    const SOL_MINT = 'So11111111111111111111111111111111111111112';

    it('produces the same key regardless of address casing', () => {
      expect(REDIS_KEYS.PRICE(SOL_MINT)).toBe(REDIS_KEYS.PRICE(SOL_MINT.toLowerCase()));
      expect(REDIS_KEYS.PRICE(SOL_MINT)).toBe(REDIS_KEYS.PRICE(SOL_MINT.toUpperCase()));
    });

    it('normalizes to lowercase, matching what the price poller writes', () => {
      expect(REDIS_KEYS.PRICE(SOL_MINT)).toBe(`price:${SOL_MINT.toLowerCase()}`);
    });

    it('keeps distinct tokens on distinct keys', () => {
      const bonk = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

      expect(REDIS_KEYS.PRICE(SOL_MINT)).not.toBe(REDIS_KEYS.PRICE(bonk));
    });

    it('retains the price: prefix', () => {
      expect(REDIS_KEYS.PRICE(SOL_MINT)).toMatch(/^price:/);
    });
  });
});
