/**
 * TokenManager — keeps accessToken fresh.
 * Refreshes 5 minutes before expiry, notifies caller via onRefreshed callback.
 * On repeated failures calls onRefreshFailed so the daemon can re-authenticate or exit.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
}

export interface TokenManagerOptions {
  /** Fetch initial token pair using stored credentials */
  fetchTokens: () => Promise<TokenPair>;
  /** Rotate token pair using current refreshToken */
  refreshTokens: (refreshToken: string) => Promise<TokenPair>;
  /** Called when a new accessToken is available (e.g. WS reconnect) */
  onRefreshed: (tokens: TokenPair) => void;
  /** Called when all refresh retries are exhausted — daemon should re-authenticate or exit */
  onRefreshFailed?: (error: Error) => void;
  /** Seconds before expiry to trigger refresh (default: 5 * 60) */
  refreshBeforeExpiry?: number;
  /** Max consecutive refresh retry attempts before calling onRefreshFailed (default: 3) */
  maxRefreshRetries?: number;
}

const RETRY_DELAY_MS = 30_000;
const CLOCK_SKEW_MARGIN_S = 60; // treat token as expired this many seconds before server expiry
const MAX_EXPIRES_IN_S = 86400 * 365; // sanity cap: 1 year

export class TokenManager {
  private tokens: TokenPair | null = null;
  private tokenExpiresAt = 0; // Unix ms
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly refreshBefore: number;
  private readonly maxRetries: number;
  private retryCount = 0;

  constructor(private readonly opts: TokenManagerOptions) {
    this.refreshBefore = opts.refreshBeforeExpiry ?? 5 * 60;
    this.maxRetries = opts.maxRefreshRetries ?? 3;
  }

  async start(): Promise<string> {
    this.tokens = await this.opts.fetchTokens();
    this.tokenExpiresAt = this.calcExpiresAt(this.tokens.expiresIn);
    this.scheduleRefresh(this.tokens);
    return this.tokens.accessToken;
  }

  get accessToken(): string {
    if (!this.tokens) { throw new Error('TokenManager not started'); }
    if (Date.now() >= this.tokenExpiresAt - CLOCK_SKEW_MARGIN_S * 1000) {
      throw new Error('accessToken has expired — refresh has not completed yet');
    }
    return this.tokens.accessToken;
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private calcExpiresAt(expiresIn: number): number {
    if (expiresIn <= 0 || expiresIn > MAX_EXPIRES_IN_S) {
      throw new Error(`Invalid expiresIn value: ${expiresIn}`);
    }
    // Track full server lifetime. CLOCK_SKEW_MARGIN_S is applied in the
    // accessToken getter and retry guard, not here — this keeps tokenExpiresAt
    // always later than the proactive refresh schedule time.
    return Date.now() + expiresIn * 1000;
  }

  private scheduleRefresh(tokens: TokenPair): void {
    if (this.timer) { clearTimeout(this.timer); }
    const delaySec = tokens.expiresIn - this.refreshBefore;
    if (delaySec <= 0) {
      // Token already near expiry — refresh immediately
      console.warn('[token-manager] Token expires sooner than refreshBeforeExpiry, refreshing immediately');
      this.timer = setTimeout(() => void this.doRefresh(), 0);
    } else {
      this.timer = setTimeout(() => void this.doRefresh(), delaySec * 1000);
    }
  }

  private async doRefresh(): Promise<void> {
    if (!this.tokens) { return; }
    try {
      const next = await this.opts.refreshTokens(this.tokens.refreshToken);
      this.tokens = next;
      this.tokenExpiresAt = this.calcExpiresAt(next.expiresIn);
      this.retryCount = 0;
      this.scheduleRefresh(next);
      this.opts.onRefreshed(next);
    } catch (err) {
      this.retryCount++;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[token-manager] Refresh failed (attempt ${this.retryCount}/${this.maxRetries}):`, error.message);

      // If the token has already expired (accounting for clock skew), retrying won't help
      if (Date.now() >= this.tokenExpiresAt - CLOCK_SKEW_MARGIN_S * 1000) {
        console.error('[token-manager] Token expired before refresh succeeded, notifying caller');
        this.opts.onRefreshFailed?.(error);
        return;
      }

      if (this.retryCount >= this.maxRetries) {
        console.error('[token-manager] Max refresh retries exceeded, notifying caller');
        this.opts.onRefreshFailed?.(error);
        return;
      }

      // Exponential backoff: 30s, 60s, 120s
      const delayMs = RETRY_DELAY_MS * Math.pow(2, this.retryCount - 1);
      this.timer = setTimeout(() => void this.doRefresh(), delayMs);
    }
  }
}
