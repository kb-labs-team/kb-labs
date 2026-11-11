import { describe, expect, it, vi } from "vitest";
import { ActiveWorkRegistry } from "../active-work.js";

describe("ActiveWorkRegistry", () => {
  it("collects typed work from registered enabled services and supplies their owner", async () => {
    const registry = new ActiveWorkRegistry();
    registry.register("workflow", async () => [
      { kind: "workflow", id: "run-7" },
      { kind: "job", id: "run-7:build" },
    ]);
    registry.register("service-jobs", async () => [{ kind: "service-job", id: "job-3" }]);

    await expect(registry.list()).resolves.toEqual([
      { kind: "service-job", id: "job-3", owningService: "service-jobs" },
      { kind: "job", id: "run-7:build", owningService: "workflow" },
      { kind: "workflow", id: "run-7", owningService: "workflow" },
    ]);
  });

  it("removes a provider when its service tears down", async () => {
    const registry = new ActiveWorkRegistry();
    const unregister = registry.register("workflow", async () => [{ kind: "workflow", id: "run-7" }]);
    unregister();

    await expect(registry.list()).resolves.toEqual([]);
  });

  it("refuses two providers for the same owning service", () => {
    const registry = new ActiveWorkRegistry();
    registry.register("workflow", async () => []);

    expect(() => registry.register("workflow", async () => [])).toThrow(
      'An active-work provider is already registered for service "workflow".',
    );
  });

  it("fails closed when any registered service cannot answer", async () => {
    const registry = new ActiveWorkRegistry();
    const failure = new Error("workflow storage unavailable");
    registry.register("workflow", vi.fn(async () => { throw failure; }));

    await expect(registry.list()).rejects.toBe(failure);
  });
});
