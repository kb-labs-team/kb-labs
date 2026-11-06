/**
 * @module @kb-labs/platform-client
 * Unified client SDK for KB Labs platform.
 *
 * All calls go through the Gateway's Unified Platform API:
 *   POST /platform/v1/{adapter}/{method}
 *
 * Telemetry convenience methods use the dedicated ingestion endpoint:
 *   POST /telemetry/v1/ingest
 *
 * Zero external dependencies — uses native `fetch`.
 *
 * @example
 * ```typescript
 * import { KBPlatform } from '@kb-labs/platform-client';
 *
 * const platform = new KBPlatform({
 *   endpoint: 'http://gateway:4000',
 *   apiKey: 'your-token',
 * });
 *
 * // LLM
 * const result = await platform.llm.complete('Explain this code');
 *
 * // Cache
 * await platform.cache.set('key', value, 60000);
 * const cached = await platform.cache.get('key');
 *
 * // Telemetry (batched)
 * platform.telemetry.event('user.signup', { plan: 'pro' });
 * await platform.telemetry.flush();
 *
 * // Generic call for any adapter
 * const raw = await platform.call('customAdapter', 'method', arg1);
 * ```
 */
import { decodeUxSuccessResult, isUxResult } from '@kb-labs/core-platform/ux-result';
import type { KBPlatformOptions, TelemetryEvent } from './types.js';
import { LLMProxy } from './adapters/llm.js';
import { CacheProxy } from './adapters/cache.js';
import { VectorStoreProxy } from './adapters/vector-store.js';
import { AnalyticsProxy } from './adapters/analytics.js';

export class KBPlatform {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly onError?: (error: Error) => void;

  /** LLM adapter — complete(), chatWithTools() */
  readonly llm: LLMProxy;
  /** Cache adapter — get(), set(), delete(), clear() */
  readonly cache: CacheProxy;
  /** VectorStore adapter — search(), upsert(), delete(), count() */
  readonly vectorStore: VectorStoreProxy;
  /** Analytics + telemetry — track(), event(), metric(), log(), flush() */
  readonly telemetry: AnalyticsProxy;

  constructor(options: KBPlatformOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.onError = options.onError;

    const boundCall = this.call.bind(this);
    const boundTelemetryFetch = this.sendTelemetry.bind(this);

    this.llm = new LLMProxy(boundCall);
    this.cache = new CacheProxy(boundCall);
    this.vectorStore = new VectorStoreProxy(boundCall);
    this.telemetry = new AnalyticsProxy(
      boundCall,
      boundTelemetryFetch,
      options.defaultTags?.source ?? 'platform-client',
      options.defaultTags ?? {},
      50,    // batchSize
      5000,  // flushIntervalMs
      options.onError,
    );
  }

  /**
   * Generic call to any adapter method via Unified Platform API.
   * `POST /platform/v1/{adapter}/{method}`
   */
  async call<T = unknown>(adapter: string, method: string, ...args: unknown[]): Promise<T> {
    const url = `${this.endpoint}/platform/v1/${adapter}/${method}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ args }),
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      if (!response.ok) {throw new Error(`Platform API error: ${response.status} ${text}`);}
      throw new Error('Gateway returned a response that is not a valid UX success envelope.');
    }

    if (!response.ok) {
      if (isUxResult(body) && !body.ok) {throw new Error(body.error.message);}
      throw new Error(`Platform API error: ${response.status} ${text}`);
    }
    if (isUxResult(body) && !body.ok) {throw new Error(body.error.message);}

    return decodeUxSuccessResult<T>(body);
  }

  /**
   * Send telemetry events via dedicated ingestion endpoint.
   * `POST /telemetry/v1/ingest`
   */
  private async sendTelemetry(events: TelemetryEvent[]): Promise<void> {
    const url = `${this.endpoint}/telemetry/v1/ingest`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ events }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Telemetry ingest failed: ${response.status} ${text}`);
    }
  }

  /** Flush buffered telemetry and stop timers. */
  async shutdown(): Promise<void> {
    await this.telemetry.shutdown();
  }
}
