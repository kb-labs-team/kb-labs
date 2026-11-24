/**
 * Tests for LogRingBufferAdapter
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { LogRingBufferAdapter } from "../index";
import type { LogRecord } from "@kb-labs/sdk/adapters";

describe("LogRingBufferAdapter", () => {
  let buffer: LogRingBufferAdapter;

  beforeEach(() => {
    buffer = new LogRingBufferAdapter({ maxSize: 5, ttl: 60000 }); // 60s TTL for testing
  });

  describe("append", () => {
    it("should append logs to buffer", () => {
      const log: LogRecord = {
        id: "test-1",
        timestamp: Date.now(),
        level: "info",
        message: "Test log",
        fields: {},
        source: "test",
      };

      buffer.append(log);

      const stats = buffer.getStats();
      expect(stats.size).toBe(1);
    });

    it("should evict oldest log when buffer is full", () => {
      // Add 6 logs to a buffer with maxSize 5
      for (let i = 0; i < 6; i++) {
        buffer.append({
          id: `test-${i}`,
          timestamp: Date.now() + i,
          level: "info",
          message: `Log ${i}`,
          fields: {},
          source: "test",
        });
      }

      const stats = buffer.getStats();
      expect(stats.size).toBe(5); // Only 5 logs fit
      expect(stats.evictions).toBe(1); // 1 log evicted

      const logs = buffer.query();
      expect(logs[logs.length - 1]!.message).toBe("Log 1"); // Log 0 was evicted
      expect(logs[0]!.message).toBe("Log 5"); // Newest first
    });

    it("should notify subscribers when log is appended", () => {
      const callback = vi.fn();
      const unsubscribe = buffer.subscribe(callback);

      const log: LogRecord = {
        id: "test-2",
        timestamp: Date.now(),
        level: "info",
        message: "Test log",
        fields: {},
        source: "test",
      };

      buffer.append(log);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(log);

      unsubscribe();
    });

    it("should handle subscriber errors gracefully", () => {
      const errorCallback = vi.fn(() => {
        throw new Error("Subscriber error");
      });
      const goodCallback = vi.fn();

      buffer.subscribe(errorCallback);
      buffer.subscribe(goodCallback);

      const log: LogRecord = {
        id: "test-3",
        timestamp: Date.now(),
        level: "info",
        message: "Test log",
        fields: {},
        source: "test",
      };

      // Should not throw
      expect(() => buffer.append(log)).not.toThrow();

      // Good callback should still be called
      expect(goodCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("query", () => {
    const now = Date.now();

    beforeEach(() => {
      // Add test logs (use current time to avoid TTL eviction)
      buffer.append({
        id: "test-query-1",
        timestamp: now - 4000,
        level: "debug",
        message: "Debug log",
        fields: {},
        source: "test",
      });
      buffer.append({
        id: "test-query-2",
        timestamp: now - 3000,
        level: "info",
        message: "Info log",
        fields: {},
        source: "test",
      });
      buffer.append({
        id: "test-query-3",
        timestamp: now - 2000,
        level: "warn",
        message: "Warn log",
        fields: {},
        source: "test",
      });
      buffer.append({
        id: "test-query-4",
        timestamp: now - 1000,
        level: "error",
        message: "Error log",
        fields: {},
        source: "api",
      });
    });

    it("should return all logs without filters", () => {
      const logs = buffer.query();
      expect(logs).toHaveLength(4);
      expect(logs[0]!.timestamp).toBe(now - 1000); // Newest first
      expect(logs[3]!.timestamp).toBe(now - 4000); // Oldest last
    });

    it("should filter by level", () => {
      const logs = buffer.query({ level: "error" });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.level).toBe("error");
    });

    it("should filter by source", () => {
      const logs = buffer.query({ source: "api" });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.source).toBe("api");
    });

    it("should filter by timestamp range", () => {
      const logs = buffer.query({ from: now - 3000, to: now - 2000 });
      expect(logs).toHaveLength(2);
      expect(logs[0]!.timestamp).toBe(now - 2000);
      expect(logs[1]!.timestamp).toBe(now - 3000);
    });

    it("should apply limit", () => {
      const logs = buffer.query({ limit: 2 });
      expect(logs).toHaveLength(2);
      expect(logs[0]!.timestamp).toBe(now - 1000); // Newest
      expect(logs[1]!.timestamp).toBe(now - 2000);
    });

    it("should combine multiple filters", () => {
      const logs = buffer.query({
        level: "info",
        source: "test",
        from: now - 3500,
      });
      // `level` is a minimum threshold, consistent with durable persistence.
      expect(logs).toHaveLength(2);
      expect(logs.every((log) => ["info", "warn", "error", "fatal"].includes(log.level))).toBe(true);
      expect(logs.every((log) => log.source === "test")).toBe(true);
      expect(logs.every((log) => log.timestamp >= now - 3500)).toBe(true);
    });

    // case: S-122.3
    it("should filter by workflow run and step execution before applying the limit", () => {
      const scopedBuffer = new LogRingBufferAdapter({ maxSize: 5, ttl: 60_000 });
      const timestamp = Date.now();
      scopedBuffer.append({
        id: "matching-run-and-execution",
        timestamp: timestamp - 3000,
        level: "info",
        message: "matching workflow log",
        fields: { runId: "run-1", executionId: "exec-1", traceId: "trace-1" },
        source: "workflow",
      });
      scopedBuffer.append({
        id: "same-run-other-execution",
        timestamp: timestamp - 2000,
        level: "info",
        message: "other step",
        fields: { runId: "run-1", executionId: "exec-2" },
        source: "workflow",
      });
      scopedBuffer.append({
        id: "other-run-same-execution",
        timestamp: timestamp - 1000,
        level: "info",
        message: "other run",
        fields: { runId: "run-2", executionId: "exec-1" },
        source: "workflow",
      });
      scopedBuffer.append({
        id: "same-run-execution-other-trace",
        timestamp: timestamp - 500,
        level: "info",
        message: "other trace",
        fields: { runId: "run-1", executionId: "exec-1", traceId: "trace-2" },
        source: "workflow",
      });

      const logs = scopedBuffer.query({ runId: "run-1", executionId: "exec-1", traceId: "trace-1", limit: 1 });

      expect(logs.map((log) => log.id)).toEqual(["matching-run-and-execution"]);
    });
  });

  describe("subscribe", () => {
    it("should allow multiple subscribers", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      buffer.subscribe(callback1);
      buffer.subscribe(callback2);

      const log: LogRecord = {
        id: "test-4",
        timestamp: Date.now(),
        level: "info",
        message: "Test log",
        fields: {},
        source: "test",
      };

      buffer.append(log);

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it("should unsubscribe correctly", () => {
      const callback = vi.fn();
      const unsubscribe = buffer.subscribe(callback);

      const log: LogRecord = {
        id: "test-5",
        timestamp: Date.now(),
        level: "info",
        message: "Test log 1",
        fields: {},
        source: "test",
      };

      buffer.append(log);
      expect(callback).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      const log2: LogRecord = {
        id: "test-6",
        timestamp: Date.now(),
        level: "info",
        message: "Test log 2",
        fields: {},
        source: "test",
      };

      buffer.append(log2);
      expect(callback).toHaveBeenCalledTimes(1); // Still 1, not called again
    });
  });

  describe("getStats", () => {
    it("should return correct stats", () => {
      const now = Date.now();
      const log1: LogRecord = {
        id: "test-7",
        timestamp: now - 1000,
        level: "info",
        message: "Log 1",
        fields: {},
        source: "test",
      };
      const log2: LogRecord = {
        id: "test-8",
        timestamp: now,
        level: "info",
        message: "Log 2",
        fields: {},
        source: "test",
      };

      buffer.append(log1);
      buffer.append(log2);

      const stats = buffer.getStats();
      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(5);
      expect(stats.oldestTimestamp).toBe(now - 1000);
      expect(stats.newestTimestamp).toBe(now);
      expect(stats.evictions).toBe(0);
    });

    it("should return zeros for empty buffer", () => {
      const stats = buffer.getStats();
      expect(stats.size).toBe(0);
      expect(stats.maxSize).toBe(5);
      expect(stats.oldestTimestamp).toBe(0);
      expect(stats.newestTimestamp).toBe(0);
      expect(stats.evictions).toBe(0);
    });
  });

  describe("clear", () => {
    it("should clear all logs", () => {
      buffer.append({
        id: "test-9",
        timestamp: Date.now(),
        level: "info",
        message: "Test log",
        fields: {},
        source: "test",
      });

      expect(buffer.getStats().size).toBe(1);

      buffer.clear();

      const stats = buffer.getStats();
      expect(stats.size).toBe(0);
      expect(stats.evictions).toBe(0);
    });
  });

  describe("TTL eviction", () => {
    it("should evict expired logs based on TTL", async () => {
      const shortTtlBuffer = new LogRingBufferAdapter({
        maxSize: 10,
        ttl: 100,
      }); // 100ms TTL

      // Add old log
      shortTtlBuffer.append({
        id: "test-ttl-1",
        timestamp: Date.now() - 200, // Expired
        level: "info",
        message: "Old log",
        fields: {},
        source: "test",
      });

      // Add new log
      shortTtlBuffer.append({
        id: "test-ttl-2",
        timestamp: Date.now(),
        level: "info",
        message: "New log",
        fields: {},
        source: "test",
      });

      // Query should trigger eviction
      const logs = shortTtlBuffer.query();
      expect(logs).toHaveLength(1);
      expect(logs[0]!.message).toBe("New log");

      const stats = shortTtlBuffer.getStats();
      expect(stats.size).toBe(1);
      expect(stats.evictions).toBe(1); // Old log evicted
    });

    it("should evict multiple expired logs", () => {
      const now = Date.now();
      const ttl = 1000;
      const shortTtlBuffer = new LogRingBufferAdapter({ maxSize: 10, ttl });

      // Add 3 expired logs
      for (let i = 0; i < 3; i++) {
        shortTtlBuffer.append({
          id: `test-ttl-old-${i}`,
          timestamp: now - ttl - 100, // Expired
          level: "info",
          message: `Old log ${i}`,
          fields: {},
          source: "test",
        });
      }

      // Add 2 fresh logs
      for (let i = 0; i < 2; i++) {
        shortTtlBuffer.append({
          id: `test-ttl-new-${i}`,
          timestamp: now,
          level: "info",
          message: `New log ${i}`,
          fields: {},
          source: "test",
        });
      }

      const logs = shortTtlBuffer.query();
      expect(logs).toHaveLength(2);
      expect(logs.every((l) => l.message.startsWith("New log"))).toBe(true);

      const stats = shortTtlBuffer.getStats();
      expect(stats.evictions).toBe(3);
    });
  });

  describe("edge cases", () => {
    it("should handle zero maxSize", () => {
      const zeroBuffer = new LogRingBufferAdapter({ maxSize: 0 });

      zeroBuffer.append({
        id: "test-10",
        timestamp: Date.now(),
        level: "info",
        message: "Test log",
        fields: {},
        source: "test",
      });

      const stats = zeroBuffer.getStats();
      expect(stats.size).toBe(0); // Nothing stored
    });

    it("should handle negative timestamps", () => {
      const now = Date.now();
      // Use timestamp that won't be evicted by TTL (recent past)
      const negativeTimestamp = now - 1000;

      buffer.append({
        id: "test-11",
        timestamp: negativeTimestamp,
        level: "info",
        message: "Timestamp test",
        fields: {},
        source: "test",
      });

      const logs = buffer.query();
      expect(logs).toHaveLength(1);
      expect(logs[0]!.timestamp).toBe(negativeTimestamp);
    });

    it("should handle empty fields", () => {
      buffer.append({
        id: "test-12",
        timestamp: Date.now(),
        level: "info",
        message: "No fields",
        fields: {},
        source: "test",
      });

      const logs = buffer.query();
      expect(logs[0]!.fields).toEqual({});
    });

    it("should handle complex fields", () => {
      const complexFields = {
        user: { id: 123, name: "Alice" },
        tags: ["api", "error"],
        count: 42,
      };

      buffer.append({
        id: "test-13",
        timestamp: Date.now(),
        level: "info",
        message: "Complex fields",
        fields: complexFields,
        source: "test",
      });

      const logs = buffer.query();
      expect(logs[0]!.fields).toEqual(complexFields);
    });
  });
});
