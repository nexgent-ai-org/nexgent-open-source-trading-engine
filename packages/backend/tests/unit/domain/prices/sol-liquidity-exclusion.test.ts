/**
 * SOL Liquidity Exclusion Tests
 *
 * SOL is tracked permanently so its USD price stays fresh, but it is never a
 * position token and has no DexScreener pair of its own. When a price fetch
 * fails - a Jupiter rate-limit error, say - every unfetched address is passed to
 * the liquidity checker, which reported SOL as rug pulled and called through to
 * burn-transaction creation. No positions exist in SOL so nothing was created,
 * but the classification must not happen at all.
 */

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/**
 * Mirrors the filter in PriceUpdateManager.pollPrices that selects which
 * addresses go on to the liquidity check.
 */
function selectFailedAddresses(tracked: string[], fetched: string[]): string[] {
  const fetchedAddresses = new Set(fetched.map(a => a.toLowerCase()));
  const solAddress = SOL_MINT.toLowerCase();

  return tracked.filter(addr => {
    const normalized = addr.toLowerCase();
    if (normalized === solAddress) {
      return false;
    }
    return !fetchedAddresses.has(normalized);
  });
}

describe('failed-price address selection', () => {
  it('never sends SOL to the liquidity check, even when its price fetch failed', () => {
    // The production case: the whole batch 429s, so nothing was fetched
    const failed = selectFailedAddresses([SOL_MINT.toLowerCase(), TOKEN], []);

    expect(failed).toEqual([TOKEN]);
    expect(failed.map(a => a.toLowerCase())).not.toContain(SOL_MINT.toLowerCase());
  });

  it('excludes SOL in canonical casing too', () => {
    const failed = selectFailedAddresses([SOL_MINT, TOKEN], []);

    expect(failed).toEqual([TOKEN]);
  });

  it('still reports genuine token failures', () => {
    const other = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const failed = selectFailedAddresses([TOKEN, other], [TOKEN]);

    expect(failed).toEqual([other]);
  });

  it('reports nothing when every token was fetched', () => {
    const failed = selectFailedAddresses([SOL_MINT, TOKEN], [TOKEN]);

    expect(failed).toEqual([]);
  });
});
