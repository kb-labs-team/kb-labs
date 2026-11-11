/**
 * ExecutionHandler — capability handler for plugin execution on Workspace Agent.
 *
 * Receives ExecutionRequest from Platform (via Gateway WS call),
 * executes plugin handler locally using plugin-runtime with proxy platform.
 *
 * Flow:
 *   Platform → Gateway → WS call(adapter:'execution', method:'execute')
 *   → ExecutionHandler.handle()
 *   → LocalPluginResolver.resolve(pluginId) → local path
 *   → createProxyPlatform(GatewayTransport) → proxy LLM/cache/etc
 *   → runInProcess(descriptor, proxyPlatform, handlerPath, input)
 *   → plugin handler executes (npm packages work natively)
 *   → result → WS response → Gateway → Platform
 *
 * Security:
 * - Paths validated via LocalPluginResolver (no traversal, no escape)
 * - Plugin allowlist enforcement
 * - Execution journal for idempotency (at-most-once)
 * - Timeout via AbortSignal
 *
 * @see ADR-0017: Workspace Agent Architecture
 * @see ADR-0053: Delivery Semantics
 */

import type { CapabilityCall } from '@kb-labs/host-agent-contracts';
import type { GatewayTransport } from '@kb-labs/host-agent-core';
import { createProxyPlatform, type ITransport, type PlatformContainer } from '@kb-labs/core-runtime';
import { runInProcess, runInSubprocess } from '@kb-labs/plugin-runtime';
import { noopUI } from '@kb-labs/plugin-contracts';
import type { PluginContextDescriptor } from '@kb-labs/plugin-contracts';
import { LocalPluginResolver, type PluginInventoryEntry } from './local-plugin-resolver.js';

// ── Types ──

interface ExecutionRequest {
  executionId: string;
  pluginId: string;
  handlerRef: string;
  exportName?: string;
  input: unknown;
  descriptor: PluginContextDescriptor;
  timeoutMs?: number;
}

interface JournalEntry {
  status: 'started' | 'completed';
  result?: unknown;
  error?: string;
  startedAt: number;
}

export interface ExecutionHandlerOptions {
  gatewayTransport: GatewayTransport;
  allowedPaths: string[];
  executionMode: 'in-process' | 'subprocess';
  timeoutMs: number;
  allowedPlugins?: string[];
}

// ── Constants ──

const JOURNAL_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Handler ──

export class ExecutionHandler {
  private pluginResolver: LocalPluginResolver;
  private journal = new Map<string, JournalEntry>();
  private journalCleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: ExecutionHandlerOptions) {
    this.pluginResolver = new LocalPluginResolver(opts.allowedPaths);

    // Periodic journal cleanup
    this.journalCleanupTimer = setInterval(() => this.cleanupJournal(), JOURNAL_TTL_MS);
  }

  /** Stop background tasks */
  stop(): void {
    clearInterval(this.journalCleanupTimer);
  }

  /** Capability call dispatcher */
  async handle(call: CapabilityCall): Promise<unknown> {
    switch (call.method) {
      case 'execute':
        return this.execute(call.args[0] as ExecutionRequest);
      case 'discover':
        return this.discover();
      default:
        throw new Error(`Unknown execution method: ${call.method}`);
    }
  }

  /** Return plugin inventory */
  private async discover(): Promise<PluginInventoryEntry[]> {
    return this.pluginResolver.listPlugins();
  }

  /** Execute a plugin handler locally */
  private async execute(request: ExecutionRequest): Promise<unknown> {
    const { executionId, pluginId, handlerRef, input, descriptor, timeoutMs } = request;

    // 1. Idempotency check (at-most-once for mutating, ADR-0053)
    const existing = this.journal.get(executionId);
    if (existing) {
      if (existing.status === 'completed') {
        if (existing.error) {
          throw new Error(existing.error);
        }
        return existing.result;
      }
      throw new Error(`Execution ${executionId} already in progress`);
    }
    this.journal.set(executionId, { status: 'started', startedAt: Date.now() });

    // 2. Plugin allowlist check
    if (this.opts.allowedPlugins && this.opts.allowedPlugins.length > 0) {
      if (!this.opts.allowedPlugins.includes(pluginId)) {
        this.journal.delete(executionId);
        throw new Error(`Plugin not allowed: ${pluginId}`);
      }
    }

    // 3. Default permissions if not provided (CLI dispatch may omit them)
    if (descriptor && !descriptor.permissions) {
      descriptor.permissions = {
        fs: { read: ['.'], write: ['.'] },
        network: { fetch: [] },
        env: { read: [] },
        platform: { llm: true, cache: true },
      };
    }

    // 4. Resolve plugin locally (Workspace Agent owns path resolution)
    const resolved = await this.pluginResolver.resolve(pluginId, handlerRef);

    // 5. Create proxy platform (LLM/Cache/etc → GatewayTransport → Platform)
    const proxyPlatform = await createProxyPlatform({
      transport: this.opts.gatewayTransport as unknown as ITransport,
    });


    // 6. Setup timeout
    const effectiveTimeout = timeoutMs ?? this.opts.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      // 7. Execute plugin handler — mode determines isolation level
      const result = this.opts.executionMode === 'subprocess'
        ? await this.executeInSubprocess(resolved, descriptor, input, proxyPlatform, effectiveTimeout, controller.signal)
        : await this.executeInProcess(resolved, descriptor, input, proxyPlatform, controller.signal);

      // 8. Record success in journal
      this.journal.set(executionId, {
        status: 'completed',
        result: result,
        startedAt: this.journal.get(executionId)!.startedAt,
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Record error in journal
      this.journal.set(executionId, {
        status: 'completed',
        error: message,
        startedAt: this.journal.get(executionId)!.startedAt,
      });

      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * In-process execution (trust mode) — fast, no isolation.
   * Plugin runs in same process as Workspace Agent daemon.
   */
  private async executeInProcess(
    resolved: { pluginRoot: string; handlerPath: string },
    descriptor: PluginContextDescriptor,
    input: unknown,
    proxyPlatform: PlatformContainer,
    signal: AbortSignal,
  ): Promise<unknown> {
    const result = await runInProcess({
      descriptor,
      platform: proxyPlatform,
      ui: noopUI,
      handlerPath: resolved.handlerPath,
      input,
      signal,
      cwd: resolved.pluginRoot,
    });
    return result.data;
  }

  /**
   * Subprocess execution (balanced mode) — sandboxed, separate process.
   *
   * Flow:
   *   1. runInSubprocess starts the shared framed stdio channel
   *   2. Platform RPC frames dispatch through proxyPlatform → GatewayTransport → WS → Platform
   *   3. Subprocess applies sandbox patches and returns its result over the same stream
   */
  private async executeInSubprocess(
    resolved: { pluginRoot: string; handlerPath: string },
    descriptor: PluginContextDescriptor,
    input: unknown,
    proxyPlatform: PlatformContainer,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const result = await runInSubprocess({
      descriptor,
      platform: proxyPlatform,
      handlerPath: resolved.handlerPath,
      input,
      timeoutMs,
      signal,
      cwd: resolved.pluginRoot,
    });
    return result.data;
  }

  /** Remove expired journal entries */
  private cleanupJournal(): void {
    const now = Date.now();
    for (const [id, entry] of this.journal) {
      if (entry.status === 'completed' && now - entry.startedAt > JOURNAL_TTL_MS) {
        this.journal.delete(id);
      }
    }
  }
}
