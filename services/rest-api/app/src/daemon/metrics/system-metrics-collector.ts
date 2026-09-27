/**
 * @module @kb-labs/rest-api-app/services/system-metrics-collector
 * System metrics collector for REST API instances.
 *
 * Collects CPU, memory, uptime, and load average metrics from the current instance
 * and writes them to platform.cache with TTL for automatic cleanup.
 */

import { platform } from '@kb-labs/core-runtime';
import * as os from 'node:os';
import * as process from 'node:process';
import { getHeapStatistics } from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { updateRuntimeObservabilityMetrics } from '../../observability/prometheus-registry.js';

let latestSystemMetricsSnapshot: SystemMetrics | null = null;

/**
 * System metrics data structure
 */
export interface SystemMetrics {
  /** Instance identifier (hostname) */
  instanceId: string;

  /** Timestamp when metrics were collected (ms since epoch) */
  timestamp: number;

  /** CPU usage information */
  cpu: {
    /** User CPU time in microseconds */
    user: number;
    /** System CPU time in microseconds */
    system: number;
    /** CPU usage percentage (0-100) */
    percentage: number;
  };

  /** Memory usage information */
  memory: {
    /** Resident Set Size (bytes) - total memory allocated */
    rss: number;
    /** Heap total (bytes) - allocated heap */
    heapTotal: number;
    /** Heap used (bytes) - actual heap used */
    heapUsed: number;
    /** External memory (bytes) - C++ objects bound to JS */
    external: number;
    /** Array buffers (bytes) */
    arrayBuffers: number;
    /** V8 heap limit (bytes) */
    heapLimit: number;
    /** RSS usage percentage (0-100) */
    rssPercentage: number;
    /** Heap usage percentage (0-100) */
    heapPercentage: number;
    /** Heap used as a percentage of the V8 heap limit (0-100) */
    heapLimitPercentage: number;
  };

  /** Process uptime (seconds) */
  uptime: number;
  eventLoopLagMs: number;
  activeOperations: number;

  /** System load average (1, 5, 15 minutes) */
  loadAvg: [number, number, number];

  /** Total system memory (bytes) */
  totalMemory: number;

  /** Free system memory (bytes) */
  freeMemory: number;
}

function toFiniteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * System metrics collector
 * Periodically collects system metrics and writes to platform.cache
 */
export class SystemMetricsCollector {
  private intervalId: NodeJS.Timeout | null = null;
  private instanceId: string;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime = Date.now();
  private eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private latestMetrics: SystemMetrics | null = null;

  constructor(
    private readonly serviceId: string = 'rest',
    private readonly getActiveOperations: () => number = () => 0,
  ) {
    this.instanceId = `${os.hostname()}:${process.pid}`;
  }

  /**
   * Calculate CPU percentage based on delta
   */
  private calculateCpuPercentage(): number {
    const currentUsage = process.cpuUsage(this.lastCpuUsage);
    const currentTime = Date.now();
    const deltaTime = currentTime - this.lastCpuTime;

    // Update for next calculation
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = currentTime;

    // Calculate CPU percentage
    // cpuUsage() returns microseconds, convert to milliseconds and calculate percentage
    const cpuTimeMs = (currentUsage.user + currentUsage.system) / 1000;
    const percentage = (cpuTimeMs / deltaTime) * 100;

    // Cap at 100% (can exceed on multi-core systems)
    return Math.min(percentage, 100);
  }

  /**
   * Collect current system metrics
   */
  private collectMetrics(): SystemMetrics {
    const memoryUsage = process.memoryUsage();
    const heapLimit = getHeapStatistics().heap_size_limit;
    const totalMemory = os.totalmem();
    const heapPercentageRaw =
      memoryUsage.heapTotal > 0 ? (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100 : 0;
    const eventLoopLagMs = toFiniteNumber(Number((this.eventLoopDelay.mean / 1_000_000).toFixed(2)));
    const cpuPercentage = toFiniteNumber(this.calculateCpuPercentage());

    return {
      instanceId: this.instanceId,
      timestamp: Date.now(),
      cpu: {
        user: this.lastCpuUsage.user,
        system: this.lastCpuUsage.system,
        percentage: cpuPercentage,
      },
      memory: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers,
        heapLimit,
        rssPercentage: toFiniteNumber((memoryUsage.rss / totalMemory) * 100),
        heapPercentage: toFiniteNumber(heapPercentageRaw),
        heapLimitPercentage: toFiniteNumber((memoryUsage.heapUsed / heapLimit) * 100),
      },
      uptime: process.uptime(),
      eventLoopLagMs,
      activeOperations: this.getActiveOperations(),
      loadAvg: os.loadavg() as [number, number, number],
      totalMemory,
      freeMemory: os.freemem(),
    };
  }

  /**
   * Start collecting metrics at regular intervals
   * @param intervalMs - Collection interval in milliseconds (default: 10000ms = 10s)
   * @param ttlMs - Time-to-live for cache entries (default: 60000ms = 60s)
   */
  async start(intervalMs: number = 10000, ttlMs: number = 60000): Promise<void> {
    if (this.intervalId) {
      platform.logger.warn('SystemMetricsCollector already started');
      return;
    }

    platform.logger.info('Starting system metrics collector', {
      serviceId: this.serviceId,
      instanceId: this.instanceId,
      intervalMs,
      ttlMs,
    });

    this.eventLoopDelay.enable();

    // Collect immediately on start
    await this.collect(ttlMs);

    // Then collect at intervals
    this.intervalId = setInterval(async () => {
      await this.collect(ttlMs);
    }, intervalMs);
  }

  /**
   * Collect metrics and write to cache
   */
  private async collect(ttlMs: number): Promise<void> {
    try {
      const metrics = this.collectMetrics();
      this.latestMetrics = metrics;
      latestSystemMetricsSnapshot = metrics;

      // Write to platform.cache with TTL
      // Key pattern: system-metrics:{instanceId}
      await platform.cache.set(
        `system-metrics:${this.instanceId}`,
        metrics,
        ttlMs
      );

      updateRuntimeObservabilityMetrics({
        cpuPercent: metrics.cpu.percentage,
        rssBytes: metrics.memory.rss,
        heapUsedBytes: metrics.memory.heapUsed,
        eventLoopLagMs: metrics.eventLoopLagMs,
        activeOperations: metrics.activeOperations,
      });

      platform.logger.debug('System metrics collected', {
        serviceId: this.serviceId,
        instanceId: this.instanceId,
        cpu: metrics.cpu.percentage.toFixed(1) + '%',
        memory: metrics.memory.rssPercentage.toFixed(1) + '%',
        eventLoopLagMs: metrics.eventLoopLagMs,
        activeOperations: metrics.activeOperations,
        uptime: Math.floor(metrics.uptime) + 's',
      });

      this.eventLoopDelay.reset();
    } catch (error) {
      platform.logger.error('Failed to collect system metrics', error instanceof Error ? error : new Error(String(error)));
    }
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  getLatestMetrics(): SystemMetrics | null {
    return this.latestMetrics;
  }

  /**
   * Stop collecting metrics
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      platform.logger.info('System metrics collector stopped');
    }
    this.eventLoopDelay.disable();
  }
}

export function getLatestSystemMetrics(): SystemMetrics | null {
  return latestSystemMetricsSnapshot;
}
