import fs from "fs-extra";
import { join } from "node:path";
import { resolveRuntimeStatePath } from "@kb-labs/sdk/adapters";
import { format, parseISO } from "date-fns";
import type {
  IAnalytics,
  ICache,
  AnalyticsContext,
  EventsQuery,
  StatsQuery,
  EventsResponse,
  EventsStats,
  DailyStats,
  BufferStatus,
  DlqStatus,
  AnalyticsEvent as PlatformAnalyticsEvent,
} from "@kb-labs/sdk/adapters";

// Re-export manifest
export { manifest } from "./manifest.js";
import { randomUUID } from "node:crypto";

export interface FileAnalyticsOptions {
  /**
   * Base directory for analytics logs.
   * Defaults to `<KB_HOME>/state/<projectId>/analytics/buffer`.
   */
  baseDir?: string;
  /**
   * Filename pattern (without extension), default: "events-YYYYMMDD"
   */
  filenamePattern?: string;

  // Runtime contexts injected by loader based on manifest
  /**
   * Workspace context (injected when manifest requests 'workspace')
   */
  workspace?: { cwd: string };
  /**
   * Analytics context (injected when manifest requests 'analytics')
   */
  analytics?: AnalyticsContext;
}

/**
 * Legacy stored event format (for backward compatibility)
 */
interface StoredEventLegacy {
  type: "event" | "metric";
  timestamp: string;
  name: string;
  properties?: Record<string, unknown>;
  value?: number;
}

class FileAnalytics implements IAnalytics {
  private readonly baseDir: string;
  private readonly filenamePattern: string;
  private context: AnalyticsContext; // Removed readonly to allow setSource()
  private cache?: ICache; // Optional cache for stats caching

  constructor(
    options: FileAnalyticsOptions = {},
    context?: AnalyticsContext,
    cache?: ICache,
  ) {
    // Get cwd from workspace context (injected by loader) or fallback
    const cwd = options.workspace?.cwd ?? process.cwd();

    // No explicit baseDir: per-project runtime state lives outside the repository (ADR-0044).
    // An explicit relative baseDir resolves from cwd; an absolute one is used as-is.
    const configuredBaseDir = options.baseDir;
    this.baseDir = configuredBaseDir === undefined
      ? resolveRuntimeStatePath(cwd, ["analytics", "buffer"])
      : configuredBaseDir.startsWith("/")
        ? configuredBaseDir
        : join(cwd, configuredBaseDir);

    this.filenamePattern = options.filenamePattern ?? "events-YYYYMMDD";

    // Priority: options.analytics (injected) → legacy context param → fallback
    this.context = options.analytics ??
      context ?? {
        source: { product: "unknown", version: "0.0.0" },
        runId: randomUUID(),
        ctx: { workspace: cwd },
      };

    // Store cache if provided
    this.cache = cache;
  }

  async track(event: string, payload?: unknown): Promise<void> {
    // Create V1 event with automatic context enrichment
    const v1Event: PlatformAnalyticsEvent = {
      id: randomUUID(),
      schema: "kb.v1",
      type: event,
      ts: new Date().toISOString(),
      ingestTs: new Date().toISOString(),
      source: this.context.source,
      runId: this.context.runId,
      actor: this.context.actor,
      ctx: this.context.ctx,
      payload,
    };
    await this.writeV1(v1Event);
  }

  async metric(
    name: string,
    value: number,
    tags?: Record<string, string>,
  ): Promise<void> {
    // Metrics are tracked as events with value in payload
    const v1Event: PlatformAnalyticsEvent = {
      id: randomUUID(),
      schema: "kb.v1",
      type: name,
      ts: new Date().toISOString(),
      ingestTs: new Date().toISOString(),
      source: this.context.source,
      runId: this.context.runId,
      actor: this.context.actor,
      ctx: { ...this.context.ctx, ...tags },
      payload: { value },
    };
    await this.writeV1(v1Event);
  }

  async identify(
    userId: string,
    traits?: Record<string, unknown>,
  ): Promise<void> {
    const v1Event: PlatformAnalyticsEvent = {
      id: randomUUID(),
      schema: "kb.v1",
      type: "user.identify",
      ts: new Date().toISOString(),
      ingestTs: new Date().toISOString(),
      source: this.context.source,
      runId: this.context.runId,
      actor: {
        type: "user",
        id: userId,
        name: (traits?.name as string) || undefined,
      },
      ctx: this.context.ctx,
      payload: traits,
    };
    await this.writeV1(v1Event);
  }

  async flush(): Promise<void> {
    // No buffering, so nothing to flush
  }

  /**
   * Get current source attribution
   *
   * Returns the current source used for tracking events.
   * Useful for saving and restoring source in nested plugin execution.
   *
   * @returns Current source (product + version)
   */
  getSource(): { product: string; version: string } {
    return this.context.source;
  }

  /**
   * Override source attribution for scoped execution
   *
   * This allows plugins to track events with their own source (product + version)
   * instead of using the root package.json source.
   *
   * @param source - New source to use for future events
   */
  setSource(source: { product: string; version: string }): void {
    this.context = {
      ...this.context,
      source,
    };
  }

  // ========================================
  // Read Methods (NEW)
  // ========================================

  async getEvents(query?: EventsQuery): Promise<EventsResponse> {
    const allEvents = await this.readAllEvents();

    // Apply filters
    let filtered = allEvents;

    if (query?.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      filtered = filtered.filter((e) => types.includes(e.type));
    }

    if (query?.source) {
      filtered = filtered.filter((e) => e.source.product === query.source);
    }

    if (query?.actor) {
      filtered = filtered.filter((e) => e.actor?.type === query.actor);
    }

    if (query?.from) {
      const fromTs = parseISO(query.from).getTime();
      filtered = filtered.filter((e) => parseISO(e.ts).getTime() >= fromTs);
    }

    if (query?.to) {
      const toTs = parseISO(query.to).getTime();
      filtered = filtered.filter((e) => parseISO(e.ts).getTime() <= toTs);
    }

    // Sort by timestamp descending (newest first)
    filtered.sort(
      (a, b) => parseISO(b.ts).getTime() - parseISO(a.ts).getTime(),
    );

    // Apply pagination
    const limit = query?.limit ?? 100;
    const offset = query?.offset ?? 0;
    const paginated = filtered.slice(offset, offset + limit);

    return {
      events: paginated,
      total: filtered.length,
      hasMore: offset + limit < filtered.length,
    };
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- Analytics aggregation with grouping, counting, and date ranges
  async getStats(): Promise<EventsStats> {
    // Cache key for stats
    const cacheKey = "analytics:file:stats";

    // Try to get from cache first (if cache adapter was provided)
    if (this.cache) {
      try {
        const cached = await this.cache.get<EventsStats>(cacheKey);
        if (cached) {
          return cached;
        }
      } catch {
        // Cache miss or error, continue to compute
      }
    }

    // Compute stats
    const allEvents = await this.readAllEvents();

    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byActor: Record<string, number> = {};

    for (const event of allEvents) {
      byType[event.type] = (byType[event.type] || 0) + 1;
      if (event.source?.product) {
        bySource[event.source.product] =
          (bySource[event.source.product] || 0) + 1;
      }
      if (event.actor) {
        byActor[event.actor.type] = (byActor[event.actor.type] || 0) + 1;
      }
    }

    let oldestTs = Date.now();
    let newestTs = Date.now();

    if (allEvents.length > 0) {
      const firstTs = parseISO(allEvents[0]!.ts).getTime();
      oldestTs = firstTs;
      newestTs = firstTs;

      for (const event of allEvents) {
        const ts = parseISO(event.ts).getTime();
        if (ts < oldestTs) {
          oldestTs = ts;
        }
        if (ts > newestTs) {
          newestTs = ts;
        }
      }
    }

    const stats: EventsStats = {
      totalEvents: allEvents.length,
      byType,
      bySource,
      byActor,
      timeRange: {
        from: new Date(oldestTs).toISOString(),
        to: new Date(newestTs).toISOString(),
      },
    };

    // Cache result for 60 seconds (if cache adapter was provided)
    if (this.cache) {
      try {
        await this.cache.set(cacheKey, stats, 60 * 1000);
      } catch {
        // Ignore cache write errors
      }
    }

    return stats;
  }

   
  async getDailyStats(query?: StatsQuery): Promise<DailyStats[]> {
    const { events } = await this.getEvents(query);

    const groupBy = query?.groupBy ?? "day";
    const breakdownBy = query?.breakdownBy;
    const metricsFilter = query?.metrics;

    // Build date bucket key from event timestamp
    const getBucketKey = (ts: string): string => {
      const d = parseISO(ts);
      switch (groupBy) {
        case "hour":
          return format(d, "yyyy-MM-dd'T'HH");
        case "week":
          return format(d, "yyyy-'W'II");
        case "month":
          return format(d, "yyyy-MM");
        default:
          return format(d, "yyyy-MM-dd");
      }
    };

    // Read a nested field by dot-notation path from an event object
    const getFieldValue = (event: PlatformAnalyticsEvent, path: string): string => {
      const parts = path.split(".");
      let cur: unknown = event;
      for (const part of parts) {
        if (cur === null || cur === undefined || typeof cur !== "object") {return "";}
        cur = (cur as Record<string, unknown>)[part];
      }
      return cur === null || cur === undefined ? "" : String(cur);
    };

    // Group events by bucket key + optional breakdown value
    // Map key: `${bucketKey}::${breakdownValue}` (or just bucketKey when no breakdown)
    const groups = new Map<string, { date: string; breakdown?: string; events: PlatformAnalyticsEvent[] }>();

    for (const event of events) {
      const bucketKey = getBucketKey(event.ts);
      const breakdownValue = breakdownBy ? getFieldValue(event, breakdownBy) : undefined;
      const groupKey = breakdownValue !== undefined ? `${bucketKey}::${breakdownValue}` : bucketKey;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, { date: bucketKey, breakdown: breakdownValue, events: [] });
      }
      groups.get(groupKey)!.events.push(event);
    }

    const dailyStats: DailyStats[] = [];

    for (const { date, breakdown, events: groupEvents } of groups.values()) {
      const metrics = this.aggregateMetricsForGroup(groupEvents, metricsFilter);
      const entry: DailyStats = {
        date,
        count: groupEvents.length,
        metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
      };
      if (breakdown !== undefined) {entry.breakdown = breakdown;}
      dailyStats.push(entry);
    }

    dailyStats.sort((a, b) => {
      const dateCmp = a.date.localeCompare(b.date);
      if (dateCmp !== 0) {return dateCmp;}
      return (a.breakdown ?? "").localeCompare(b.breakdown ?? "");
    });

    return dailyStats;
  }

  async getBufferStatus(): Promise<BufferStatus | null> {
    // File-based analytics doesn't have a WAL buffer
    // But we can return info about stored files
    try {
      await fs.ensureDir(this.baseDir);
      const files = await fs.readdir(this.baseDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      if (jsonlFiles.length === 0) {
        return null;
      }

      let totalSize = 0;
      const timestamps: number[] = [];

      for (const file of jsonlFiles) {
        const filePath = join(this.baseDir, file);
         
        const stats = await fs.stat(filePath);
        totalSize += stats.size;

        // Read first and last line to get timestamps
         
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content
          .trim()
          .split("\n")
          .filter((l) => l.length > 0);

        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            // Handle both V1 and legacy formats
            const ts = event.ts || event.timestamp;
            if (ts) {
              timestamps.push(parseISO(ts).getTime());
            }
          } catch {
            // Skip invalid lines
          }
        }
      }

      return {
        segments: jsonlFiles.length,
        totalSizeBytes: totalSize,
        oldestEventTs:
          timestamps.length > 0
            ? new Date(Math.min(...timestamps)).toISOString()
            : null,
        newestEventTs:
          timestamps.length > 0
            ? new Date(Math.max(...timestamps)).toISOString()
            : null,
      };
    } catch (_error) {
      return null;
    }
  }

  async getDlqStatus(): Promise<DlqStatus | null> {
    // File-based analytics doesn't have a DLQ
    return null;
  }

  // ========================================
  // Private Methods
  // ========================================

  private shouldIncludeMetric(metricsFilter: string[] | undefined, key: string): boolean {
    return !metricsFilter || metricsFilter.includes(key);
  }

  private readNumeric(payload: unknown, key: string): number {
    const value = (payload as Record<string, unknown> | undefined)?.[key];
    return typeof value === "number" ? value : 0;
  }

  private aggregateLlmMetrics(
    groupEvents: PlatformAnalyticsEvent[],
    metricsFilter?: string[],
  ): Record<string, number> {
    let totalTokens = 0;
    let totalCost = 0;
    let totalDuration = 0;

    for (const event of groupEvents) {
      totalTokens += this.readNumeric(event.payload, "totalTokens");
      const estimatedCost = this.readNumeric(event.payload, "estimatedCost");
      totalCost += estimatedCost || this.readNumeric(event.payload, "cost");
      totalDuration += this.readNumeric(event.payload, "durationMs");
    }

    const metrics: Record<string, number> = {};
    if (this.shouldIncludeMetric(metricsFilter, "totalTokens")) {
      metrics.totalTokens = totalTokens;
    }
    if (this.shouldIncludeMetric(metricsFilter, "totalCost")) {
      metrics.totalCost = totalCost;
    }
    if (this.shouldIncludeMetric(metricsFilter, "avgDurationMs")) {
      metrics.avgDurationMs =
        groupEvents.length > 0 ? totalDuration / groupEvents.length : 0;
    }
    return metrics;
  }

  private aggregateEmbeddingsMetrics(
    groupEvents: PlatformAnalyticsEvent[],
    metricsFilter?: string[],
  ): Record<string, number> {
    let totalTokens = 0;
    let totalCost = 0;
    let totalDuration = 0;

    for (const event of groupEvents) {
      totalTokens += this.readNumeric(event.payload, "tokens");
      const estimatedCost = this.readNumeric(event.payload, "estimatedCost");
      totalCost += estimatedCost || this.readNumeric(event.payload, "cost");
      totalDuration += this.readNumeric(event.payload, "durationMs");
    }

    const metrics: Record<string, number> = {};
    if (this.shouldIncludeMetric(metricsFilter, "totalTokens")) {
      metrics.totalTokens = totalTokens;
    }
    if (this.shouldIncludeMetric(metricsFilter, "totalCost")) {
      metrics.totalCost = totalCost;
    }
    if (this.shouldIncludeMetric(metricsFilter, "avgDurationMs")) {
      metrics.avgDurationMs =
        groupEvents.length > 0 ? totalDuration / groupEvents.length : 0;
    }
    return metrics;
  }

  private aggregateVectorstoreMetrics(
    groupEvents: PlatformAnalyticsEvent[],
    metricsFilter?: string[],
  ): Record<string, number> {
    let totalSearches = 0;
    let totalUpserts = 0;
    let totalDeletes = 0;
    let totalDuration = 0;

    for (const event of groupEvents) {
      if (event.type.includes("search")) {
        totalSearches++;
      }
      if (event.type.includes("upsert")) {
        totalUpserts++;
      }
      if (event.type.includes("delete")) {
        totalDeletes++;
      }
      totalDuration += this.readNumeric(event.payload, "durationMs");
    }

    const metrics: Record<string, number> = {};
    if (this.shouldIncludeMetric(metricsFilter, "totalSearches")) {
      metrics.totalSearches = totalSearches;
    }
    if (this.shouldIncludeMetric(metricsFilter, "totalUpserts")) {
      metrics.totalUpserts = totalUpserts;
    }
    if (this.shouldIncludeMetric(metricsFilter, "totalDeletes")) {
      metrics.totalDeletes = totalDeletes;
    }
    if (this.shouldIncludeMetric(metricsFilter, "avgDurationMs")) {
      metrics.avgDurationMs =
        groupEvents.length > 0 ? totalDuration / groupEvents.length : 0;
    }
    return metrics;
  }

  private aggregateCacheMetrics(
    groupEvents: PlatformAnalyticsEvent[],
    metricsFilter?: string[],
  ): Record<string, number> {
    let totalHits = 0;
    let totalMisses = 0;
    let totalSets = 0;

    for (const event of groupEvents) {
      if (event.type === "cache.hit") {
        totalHits++;
      }
      if (event.type === "cache.miss") {
        totalMisses++;
      }
      if (event.type === "cache.set") {
        totalSets++;
      }
    }

    const totalGets = totalHits + totalMisses;
    const metrics: Record<string, number> = {};
    if (this.shouldIncludeMetric(metricsFilter, "totalHits")) {
      metrics.totalHits = totalHits;
    }
    if (this.shouldIncludeMetric(metricsFilter, "totalMisses")) {
      metrics.totalMisses = totalMisses;
    }
    if (this.shouldIncludeMetric(metricsFilter, "totalSets")) {
      metrics.totalSets = totalSets;
    }
    if (this.shouldIncludeMetric(metricsFilter, "hitRate")) {
      metrics.hitRate = totalGets > 0 ? (totalHits / totalGets) * 100 : 0;
    }
    return metrics;
  }

  private aggregateStorageMetrics(
    groupEvents: PlatformAnalyticsEvent[],
    metricsFilter?: string[],
  ): Record<string, number> {
    let totalBytesRead = 0;
    let totalBytesWritten = 0;
    let totalDuration = 0;

    for (const event of groupEvents) {
      totalBytesRead += this.readNumeric(event.payload, "bytesRead");
      totalBytesWritten += this.readNumeric(event.payload, "bytesWritten");
      totalDuration += this.readNumeric(event.payload, "durationMs");
    }

    const metrics: Record<string, number> = {};
    if (this.shouldIncludeMetric(metricsFilter, "totalBytesRead")) {
      metrics.totalBytesRead = totalBytesRead;
    }
    if (this.shouldIncludeMetric(metricsFilter, "totalBytesWritten")) {
      metrics.totalBytesWritten = totalBytesWritten;
    }
    if (this.shouldIncludeMetric(metricsFilter, "avgDurationMs")) {
      metrics.avgDurationMs =
        groupEvents.length > 0 ? totalDuration / groupEvents.length : 0;
    }
    return metrics;
  }

  private aggregateMetricsForGroup(
    groupEvents: PlatformAnalyticsEvent[],
    metricsFilter?: string[],
  ): Record<string, number> {
    const firstType = groupEvents[0]?.type ?? "";

    if (firstType.startsWith("llm.")) {
      return this.aggregateLlmMetrics(groupEvents, metricsFilter);
    }
    if (firstType.startsWith("embeddings.")) {
      return this.aggregateEmbeddingsMetrics(groupEvents, metricsFilter);
    }
    if (firstType.startsWith("vectorstore.")) {
      return this.aggregateVectorstoreMetrics(groupEvents, metricsFilter);
    }
    if (firstType.startsWith("cache.")) {
      return this.aggregateCacheMetrics(groupEvents, metricsFilter);
    }
    if (firstType.startsWith("storage.")) {
      return this.aggregateStorageMetrics(groupEvents, metricsFilter);
    }
    return {};
  }

  /**
   * Write V1 event directly to file (new format)
   */
  private async writeV1(event: PlatformAnalyticsEvent): Promise<void> {
    const dateStr = format(new Date(), "yyyyMMdd");
    const filename =
      this.filenamePattern.replace("YYYYMMDD", dateStr) + ".jsonl";
    const fullPath = join(this.baseDir, filename);
    await fs.ensureDir(this.baseDir);
    await fs.appendFile(fullPath, JSON.stringify(event) + "\n", {
      encoding: "utf8",
    });
  }

  /**
   * Read all events from all .jsonl files.
   * Supports both V1 format (schema: "kb.v1") and legacy format (for backward compatibility).
   */
  private async readAllEvents(): Promise<PlatformAnalyticsEvent[]> {
    try {
      await fs.ensureDir(this.baseDir);
      const files = await fs.readdir(this.baseDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      const events: PlatformAnalyticsEvent[] = [];

      for (const file of jsonlFiles) {
        const filePath = join(this.baseDir, file);
         
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content
          .trim()
          .split("\n")
          .filter((l) => l.length > 0);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);

            // Check if it's already V1 format
            if (parsed.schema === "kb.v1") {
              events.push(parsed as PlatformAnalyticsEvent);
            } else {
              // Legacy format - convert to V1
              const legacy = parsed as StoredEventLegacy;
              const mapped = this.mapLegacyToPlatformEvent(legacy);
              events.push(mapped);
            }
          } catch (error) {
            // Skip invalid lines
            console.warn(`Failed to parse line in ${file}:`, error);
          }
        }
      }

      return events;
    } catch (error) {
      console.warn("Failed to read events:", error);
      return [];
    }
  }

  /**
   * Map legacy stored event format to platform AnalyticsEvent format (kb.v1 schema)
   * Used for backward compatibility with old events.
   */
  private mapLegacyToPlatformEvent(
    stored: StoredEventLegacy,
  ): PlatformAnalyticsEvent {
    // Extract actor info from properties if available
    const userId = stored.properties?.userId as string | undefined;
    const actorType = stored.properties?.actorType as
      | "user"
      | "agent"
      | "ci"
      | undefined;
    const actorName = stored.properties?.actorName as string | undefined;

    // Extract source info from properties if available
    const sourceProduct =
      (stored.properties?.source as string) || "file-analytics";
    const sourceVersion = (stored.properties?.version as string) || "0.1.0";

    // Extract runId from properties if available
    const runId = (stored.properties?.runId as string) || randomUUID();

    // Build actor object
    const actor =
      userId || actorType
        ? {
            type: actorType || "user",
            id: userId,
            name: actorName,
          }
        : undefined;

    // Build context from properties
    const ctx: Record<string, string | number | boolean | null> = {};
    if (stored.properties) {
      for (const [key, value] of Object.entries(stored.properties)) {
        // Skip internal fields
        if (
          [
            "userId",
            "actorType",
            "actorName",
            "source",
            "version",
            "runId",
          ].includes(key)
        ) {
          continue;
        }

        // Only include primitive values in ctx
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          value === null
        ) {
          ctx[key] = value;
        }
      }
    }

    return {
      id: randomUUID(),
      schema: "kb.v1" as const,
      type: stored.name,
      ts: stored.timestamp,
      ingestTs: stored.timestamp,
      source: {
        product: sourceProduct,
        version: sourceVersion,
      },
      runId,
      actor,
      ctx: Object.keys(ctx).length > 0 ? ctx : undefined,
      payload:
        stored.type === "metric" && stored.value !== undefined
          ? { value: stored.value }
          : stored.properties,
    };
  }
}

function isAnalyticsContext(value: unknown): value is AnalyticsContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const source = (value as { source?: unknown }).source;
  if (!source || typeof source !== "object") {
    return false;
  }
  const product = (source as { product?: unknown }).product;
  const version = (source as { version?: unknown }).version;
  return typeof product === "string" && typeof version === "string";
}

export function createAdapter(
  options?: FileAnalyticsOptions,
  depsOrContext?: Record<string, unknown> | AnalyticsContext,
): IAnalytics {
  const deps =
    depsOrContext && !isAnalyticsContext(depsOrContext)
      ? depsOrContext
      : undefined;
  const cache = deps?.cache as ICache | undefined;

  const legacyContext = isAnalyticsContext(depsOrContext)
    ? depsOrContext
    : undefined;
  const injectedContext = isAnalyticsContext(deps?.analytics)
    ? deps.analytics
    : isAnalyticsContext(deps?.context)
      ? deps.context
      : undefined;

  const context = options?.analytics ?? injectedContext ?? legacyContext;
  const adapterOptions = context ? { ...options, analytics: context } : options;

  return new FileAnalytics(adapterOptions, context, cache);
}

export default createAdapter;
