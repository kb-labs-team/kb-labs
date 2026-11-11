import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenManager } from '../token/token-manager.js';

function makePair(expiresIn = 900) {
  return { accessToken: `at_${Math.random()}`, refreshToken: `rt_${Math.random()}`, expiresIn };
}

describe('TokenManager', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start() returns accessToken from fetchTokens', async () => {
    const pair = makePair();
    const mgr = new TokenManager({
      fetchTokens: async () => pair,
      refreshTokens: async () => makePair(),
      onRefreshed: () => {},
    });
    const token = await mgr.start();
    expect(token).toBe(pair.accessToken);
    expect(mgr.accessToken).toBe(pair.accessToken);
    mgr.stop();
  });

  it('schedules refresh before expiry and calls onRefreshed', async () => {
    // expiresIn=900s, default refreshBeforeExpiry=300s → schedule at 600s
    const first = makePair(900);
    const second = makePair(900);
    const onRefreshed = vi.fn();
    const refreshTokens = vi.fn().mockResolvedValue(second);

    const mgr = new TokenManager({
      fetchTokens: async () => first,
      refreshTokens,
      onRefreshed,
    });

    await mgr.start();
    await vi.advanceTimersByTimeAsync(601_000); // past 600s refresh point

    expect(refreshTokens).toHaveBeenCalledOnce();
    expect(refreshTokens).toHaveBeenCalledWith(first.refreshToken);
    expect(onRefreshed).toHaveBeenCalledWith(second);
    expect(mgr.accessToken).toBe(second.accessToken);
    mgr.stop();
  });

  it('retries with exponential backoff after refresh failure', async () => {
    // expiresIn=900s, refreshBefore=300s → schedule at 600s, tokenExpiresAt=900s
    // Attempt 1 fails at ~601s → retry in 30s at ~631s < 900s → succeeds
    const first = makePair(900);
    const second = makePair(900);
    const refreshTokens = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(second);

    const mgr = new TokenManager({
      fetchTokens: async () => first,
      refreshTokens,
      onRefreshed: () => {},
      maxRefreshRetries: 3,
    });

    await mgr.start();
    await vi.advanceTimersByTimeAsync(601_000); // triggers first (failing) refresh at 600s
    expect(refreshTokens).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000); // retry fires (30s * 2^0 backoff)
    expect(refreshTokens).toHaveBeenCalledTimes(2);
    expect(mgr.accessToken).toBe(second.accessToken);
    mgr.stop();
  });

  it('calls onRefreshFailed after maxRetries exceeded', async () => {
    // expiresIn=3600s, refreshBefore=300s → schedule at 3300s, tokenExpiresAt=3600s
    // 3 attempts: 3301s, 3331s (+30s), 3391s (+60s) — all < 3600s
    const first = makePair(3600);
    const onRefreshFailed = vi.fn();
    const refreshTokens = vi.fn().mockRejectedValue(new Error('auth failed'));

    const mgr = new TokenManager({
      fetchTokens: async () => first,
      refreshTokens,
      onRefreshed: () => {},
      onRefreshFailed,
      maxRefreshRetries: 3,
    });

    await mgr.start();
    await vi.advanceTimersByTimeAsync(3301_000); // attempt 1 at 3300s
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);   // attempt 2 (30s * 2^0)
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);   // attempt 3 (30s * 2^1 = 60s)
    await Promise.resolve();

    expect(refreshTokens).toHaveBeenCalledTimes(3);
    expect(onRefreshFailed).toHaveBeenCalledOnce();
    expect(onRefreshFailed.mock.calls[0]![0]).toBeInstanceOf(Error);
    mgr.stop();
  });

  it('stop() prevents further refresh', async () => {
    const refreshTokens = vi.fn();
    const mgr = new TokenManager({
      fetchTokens: async () => makePair(900),
      refreshTokens,
      onRefreshed: () => {},
    });

    await mgr.start();
    mgr.stop();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it('throws if accessToken accessed before start', () => {
    const mgr = new TokenManager({
      fetchTokens: async () => makePair(),
      refreshTokens: async () => makePair(),
      onRefreshed: () => {},
    });
    expect(() => mgr.accessToken).toThrow('not started');
  });
});
