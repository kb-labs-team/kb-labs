import { getHeapStatistics } from "node:v8";
import type { IContextLogger } from "@kb-labs/core-platform";

const HEAP_PRESSURE_THRESHOLDS = [75, 85, 90, 95] as const;

export function getHeapPressureTransitions(
  percentage: number,
  reportedThresholds: ReadonlySet<number>,
): { entered: number[]; cleared: number[] } {
  const entered: number[] = [];
  const cleared: number[] = [];
  for (const threshold of HEAP_PRESSURE_THRESHOLDS) {
    if (percentage >= threshold && !reportedThresholds.has(threshold)) {
      entered.push(threshold);
    } else if (percentage < threshold - 5 && reportedThresholds.has(threshold)) {
      cleared.push(threshold);
    }
  }
  return { entered, cleared };
}

export interface ProcessMemoryMonitorOptions {
  sampleIntervalMs?: number;
  reportIntervalMs?: number;
  now?: () => number;
  getMemoryUsage?: () => NodeJS.MemoryUsage;
  getHeapLimit?: () => number;
  getUptime?: () => number;
}

/** Shared process memory diagnostics for every service launched by shared-daemon. */
export class ProcessMemoryMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastSampleAt = 0;
  private readonly warnedThresholds = new Set<number>();
  private readonly now: () => number;
  private readonly getMemoryUsage: () => NodeJS.MemoryUsage;
  private readonly getHeapLimit: () => number;
  private readonly getUptime: () => number;

  constructor(
    private readonly logger: IContextLogger,
    private readonly options: ProcessMemoryMonitorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.getMemoryUsage = options.getMemoryUsage ?? process.memoryUsage;
    this.getHeapLimit = options.getHeapLimit ?? (() => getHeapStatistics().heap_size_limit);
    this.getUptime = options.getUptime ?? process.uptime;
  }

  start(): void {
    if (this.timer) return;
    const sample = (): void => this.collect();
    sample();
    this.timer = setInterval(sample, this.options.sampleIntervalMs ?? 10_000);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private collect(): void {
    const now = this.now();
    const memory = this.getMemoryUsage();
    const heapLimitBytes = this.getHeapLimit();
    const heapLimitPercentage = heapLimitBytes > 0
      ? (memory.heapUsed / heapLimitBytes) * 100
      : 0;
    const fields = {
      pid: process.pid,
      uptimeSeconds: Math.floor(this.getUptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      heapLimitBytes,
      heapLimitPercentage: Number(heapLimitPercentage.toFixed(1)),
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    };

    if (now - this.lastSampleAt >= (this.options.reportIntervalMs ?? 60_000)) {
      this.logger.event("info", {
        event: "process.memory.sample",
        message: "Process memory usage sample",
        fields,
      });
      this.lastSampleAt = now;
    }

    const transitions = getHeapPressureTransitions(heapLimitPercentage, this.warnedThresholds);
    for (const threshold of transitions.cleared) this.warnedThresholds.delete(threshold);
    for (const threshold of transitions.entered) {
      this.warnedThresholds.add(threshold);
      this.logger.event("warn", {
        event: "process.memory.pressure",
        message: "Process heap usage is approaching the V8 limit",
        fields: { ...fields, thresholdPercentage: threshold },
      });
    }
  }
}
