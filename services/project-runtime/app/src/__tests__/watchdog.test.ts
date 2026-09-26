import { afterEach, describe, expect, it, vi } from "vitest";
import { isProcessAlive, watchParent } from "../watchdog.js";

describe("watchParent", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls back once when the parent disappears, and stops polling", () => {
    vi.useFakeTimers();
    let alive = true;
    let calls = 0;
    const isAlive = vi.fn(() => alive);
    watchParent({
      parentPid: 4242,
      intervalMs: 100,
      isAlive,
      onParentGone: () => {
        calls += 1;
      },
    });

    vi.advanceTimersByTime(350);
    expect(calls).toBe(0);
    alive = false;
    vi.advanceTimersByTime(100);
    expect(calls).toBe(1);
    const polled = isAlive.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(1);
    expect(isAlive.mock.calls.length).toBe(polled);
  });

  it("can be stopped", () => {
    vi.useFakeTimers();
    let calls = 0;
    const stop = watchParent({
      parentPid: 4242,
      intervalMs: 100,
      isAlive: () => false,
      onParentGone: () => {
        calls += 1;
      },
    });
    stop();
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(0);
  });
});

describe("isProcessAlive", () => {
  it("knows this process is alive and a huge pid is not", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});
