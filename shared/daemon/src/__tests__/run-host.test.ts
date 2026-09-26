import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launchPlatform: vi.fn(),
}));

vi.mock("@kb-labs/core-runtime", () => ({
  launchPlatform: mocks.launchPlatform,
}));

import { defineHostModule, runHost, type HostConfig } from "../index.js";

type SignalListener = { event: string; fn: () => Promise<void> };

function makeLogger() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    forComponent: vi.fn(),
    event: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  logger.forComponent.mockReturnValue(logger);
  return logger;
}

describe("runHost", () => {
  const signalListeners: SignalListener[] = [];
  const order: string[] = [];
  let platformShutdown: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof makeLogger>;
  const originalOn = process.on.bind(process);

  function module(id: string, port: number, setup = defaultSetup(id)) {
    return defineHostModule({
      id,
      defaultPort: port,
      portEnvVar: `TEST_HOST_${id.toUpperCase()}_PORT`,
      defaultHost: "127.0.0.1",
      setup,
    });
  }

  function defaultSetup(id: string) {
    return vi.fn().mockImplementation(async () => {
      order.push(`setup:${id}`);
      return async () => {
        order.push(`teardown:${id}`);
      };
    });
  }

  function makeConfig(modules: HostConfig["modules"]): HostConfig {
    return {
      appId: "kb-host",
      platform: { assemblyHook: vi.fn() },
      modules,
    };
  }

  beforeEach(() => {
    order.length = 0;
    logger = makeLogger();
    platformShutdown = vi.fn().mockImplementation(async () => {
      order.push("platform");
    });
    mocks.launchPlatform.mockReset();
    mocks.launchPlatform.mockResolvedValue({
      platform: { getAdapter: vi.fn().mockReturnValue(undefined) },
      logger,
      roots: {
        projectRoot: "/project",
        platformRoot: "/platform",
        sameLocation: false,
      },
      shutdown: platformShutdown,
    });
    vi.spyOn(process, "on").mockImplementation((event: string | symbol, fn) => {
      if (event === "SIGTERM" || event === "SIGINT") {
        signalListeners.push({
          event: String(event),
          fn: fn as () => Promise<void>,
        });
        return process;
      }
      return originalOn(event, fn);
    });
  });

  afterEach(() => {
    signalListeners.length = 0;
    vi.restoreAllMocks();
  });

  it("launches the platform once for several modules and starts them in order", async () => {
    await runHost(makeConfig([module("a", 9001), module("b", 9002)]));

    expect(mocks.launchPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.launchPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: "kb-host",
        serviceId: "kb-host",
        kind: "service",
      }),
    );
    expect(order).toEqual(["setup:a", "setup:b"]);
  });

  it("gives each module its own resolved port and the shared roots", async () => {
    const a = module("a", 9001);
    const b = module("b", 9002);
    await runHost(makeConfig([a, b]));

    expect(a.setup).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 9001,
        host: "127.0.0.1",
        projectRoot: "/project",
        platformRoot: "/platform",
      }),
    );
    expect(b.setup).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9002, host: "127.0.0.1" }),
    );
  });

  it("registers a single SIGTERM and a single SIGINT owner regardless of module count", async () => {
    await runHost(
      makeConfig([module("a", 9001), module("b", 9002), module("c", 9003)]),
    );

    expect(signalListeners.filter((l) => l.event === "SIGTERM")).toHaveLength(1);
    expect(signalListeners.filter((l) => l.event === "SIGINT")).toHaveLength(1);
  });

  it("tears modules down in reverse order, then the platform, and exits once", async () => {
    await runHost(makeConfig([module("a", 9001), module("b", 9002)]));
    order.length = 0;
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    const sigterm = signalListeners.find((l) => l.event === "SIGTERM")!.fn;
    const sigint = signalListeners.find((l) => l.event === "SIGINT")!.fn;
    await Promise.all([sigterm(), sigint()]);

    expect(order).toEqual(["teardown:b", "teardown:a", "platform"]);
    expect(platformShutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps tearing down remaining modules when one teardown fails and exits 1", async () => {
    const failing = module("b", 9002, vi.fn().mockImplementation(async () => {
      order.push("setup:b");
      return async () => {
        order.push("teardown:b");
        throw new Error("teardown boom");
      };
    }));
    await runHost(makeConfig([module("a", 9001), failing]));
    order.length = 0;
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await signalListeners.find((l) => l.event === "SIGTERM")!.fn();

    expect(order).toEqual(["teardown:b", "teardown:a", "platform"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("when a later setup fails, tears down the started modules, shuts the platform down and rethrows", async () => {
    const boom = new Error("b failed");
    const failing = module("b", 9002, vi.fn().mockRejectedValue(boom));
    const never = module("c", 9003);

    await expect(
      runHost(makeConfig([module("a", 9001), failing, never])),
    ).rejects.toBe(boom);

    expect(order).toEqual(["setup:a", "teardown:a", "platform"]);
    expect(platformShutdown).toHaveBeenCalledWith("service.setup-failed");
    expect(never.setup).not.toHaveBeenCalled();
    expect(signalListeners).toHaveLength(0);
  });

  it("does not start any module when the platform launch fails", async () => {
    mocks.launchPlatform.mockRejectedValueOnce(new Error("launch boom"));
    const a = module("a", 9001);

    await expect(runHost(makeConfig([a]))).rejects.toThrow("launch boom");
    expect(a.setup).not.toHaveBeenCalled();
    expect(signalListeners).toHaveLength(0);
  });

  it("uses the module serviceId for the transport lookup and falls back to the module id", async () => {
    const listenAddress = vi.fn().mockReturnValue({ port: 4321, host: "10.0.0.5" });
    mocks.launchPlatform.mockResolvedValueOnce({
      platform: { getAdapter: vi.fn().mockReturnValue({ listenAddress }) },
      logger,
      roots: { projectRoot: "/p", platformRoot: "/p", sameLocation: true },
      shutdown: platformShutdown,
    });
    const named = defineHostModule({
      id: "a",
      serviceId: "custom",
      defaultPort: 1,
      portEnvVar: "TEST_HOST_NAMED_PORT",
      setup: defaultSetup("a"),
    });
    await runHost(makeConfig([named, module("b", 9002)]));

    expect(listenAddress).toHaveBeenNthCalledWith(1, "custom");
    expect(listenAddress).toHaveBeenNthCalledWith(2, "b");
  });
});
