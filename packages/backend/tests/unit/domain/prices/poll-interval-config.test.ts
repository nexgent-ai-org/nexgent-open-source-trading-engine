/**
 * Price Poll Interval Configuration Tests
 *
 * PRICE_POLL_INTERVAL_MS is the largest single consumer of the Jupiter rate
 * limit, so an unusable value must fall back to the default rather than be
 * silently accepted - a typo here would quietly change how fast stop losses are
 * evaluated, or exhaust the plan's request budget.
 *
 * The module reads the environment at import time, so each case re-imports it
 * in isolation.
 */

const DEFAULT_POLL_INTERVAL_MS = 1500;

/**
 * Import PriceUpdateManager with the given env value and report the interval it
 * resolved, read back from the private field.
 */
async function resolveIntervalWith(value: string | undefined): Promise<number> {
  jest.resetModules();

  if (value === undefined) {
    delete process.env.PRICE_POLL_INTERVAL_MS;
  } else {
    process.env.PRICE_POLL_INTERVAL_MS = value;
  }

  const module = await import('@/domain/prices/price-update-manager.js');
  const manager = module.priceUpdateManager as unknown as { POLL_INTERVAL: number };

  return manager.POLL_INTERVAL;
}

describe('price poll interval configuration', () => {
  const originalValue = process.env.PRICE_POLL_INTERVAL_MS;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.PRICE_POLL_INTERVAL_MS;
    } else {
      process.env.PRICE_POLL_INTERVAL_MS = originalValue;
    }
  });

  it('defaults to 1500ms when unset', async () => {
    expect(await resolveIntervalWith(undefined)).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it('accepts a valid override', async () => {
    expect(await resolveIntervalWith('2500')).toBe(2500);
  });

  it('accepts the boundary values', async () => {
    expect(await resolveIntervalWith('500')).toBe(500);
    expect(await resolveIntervalWith('60000')).toBe(60_000);
  });

  it('falls back to the default for a value below the minimum', async () => {
    expect(await resolveIntervalWith('100')).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it('falls back to the default for a value above the maximum', async () => {
    expect(await resolveIntervalWith('120000')).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it('falls back to the default for a non-numeric value', async () => {
    expect(await resolveIntervalWith('fast')).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it('falls back to the default for a non-integer value', async () => {
    expect(await resolveIntervalWith('1500.5')).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it('falls back to the default for an empty value', async () => {
    expect(await resolveIntervalWith('')).toBe(DEFAULT_POLL_INTERVAL_MS);
  });
});
