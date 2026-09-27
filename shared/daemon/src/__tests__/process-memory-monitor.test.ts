import { afterEach, describe, expect, it, vi } from "vitest";
import { createContextLogger } from "@kb-labs/core-platform";
import type { ILogger } from "@kb-labs/core-platform";
import { getHeapPressureTransitions, ProcessMemoryMonitor } from "../process-memory-monitor.js";

function captureLogger(records: Array<Record<string, unknown>>): ILogger {
  const write = (level: string, message: string, meta?: Record<string, unknown>) => {
    records.push({ level, message, ...(meta ?? {}) });
  };
  return {
    trace: (message, meta) => write("trace", message, meta),
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, error, meta) => write("error", message, { ...meta, error }),
    fatal: (message, error, meta) => write("fatal", message, { ...meta, error }),
    child: () => captureLogger(records),
  };
}

afterEach(() => vi.useRealTimers());

describe("ProcessMemoryMonitor", () => {
  it("logs a process sample and emits threshold warnings with hysteresis", () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = createContextLogger(captureLogger(records), {
      applicationId: "gateway",
      serviceId: "gateway",
      instanceId: "host:123",
      layer: "service",
    });
    vi.useFakeTimers();
    let heapUsed = 80;
    let now = 1_000;
    const monitor = new ProcessMemoryMonitor(logger, {
      sampleIntervalMs: 10,
      reportIntervalMs: 10,
      now: () => now,
      getMemoryUsage: () => ({ rss: 100, heapTotal: 100, heapUsed, external: 5, arrayBuffers: 2 }),
      getHeapLimit: () => 100,
      getUptime: () => 3,
    });

    monitor.start();
    expect(records.map((record) => record.event)).toEqual([
      "process.memory.sample",
      "process.memory.pressure",
    ]);
    expect(records[1]?.thresholdPercentage).toBe(75);

    heapUsed = 69;
    now += 10;
    vi.advanceTimersByTime(10);
    expect(records.filter((record) => record.event === "process.memory.sample")).toHaveLength(2);
    expect(records.filter((record) => record.event === "process.memory.pressure")).toHaveLength(1);
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports heap pressure threshold transitions with hysteresis", () => {
    expect(getHeapPressureTransitions(95, new Set([75, 85, 90]))).toEqual({
      entered: [95],
      cleared: [],
    });
    expect(getHeapPressureTransitions(69, new Set([75]))).toEqual({
      entered: [],
      cleared: [75],
    });
  });
});
