import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "@kb-labs/shared-daemon";

const mocks = vi.hoisted(() => ({
  loadGatewayConfig: vi.fn(),
  createServer: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../config.js", () => ({ loadGatewayConfig: mocks.loadGatewayConfig }));
vi.mock("../server.js", () => ({ createServer: mocks.createServer }));
vi.mock("@kb-labs/core-registry", () => ({
  createRegistry: vi.fn().mockRejectedValue(new Error("no registry in test")),
}));
vi.mock("@kb-labs/gateway-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kb-labs/gateway-auth")>()),
  evaluateAuthReadiness: vi.fn().mockResolvedValue({
    ok: true,
    issues: [],
    authEnabled: false,
    activeAdmins: 0,
  }),
}));

import { setup } from "../bootstrap.js";

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
    forOperation: vi.fn(),
    event: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  logger.forComponent.mockReturnValue(logger);
  logger.forOperation.mockReturnValue(logger);
  return logger;
}

function makeContext(overrides: Partial<ServiceContext>): ServiceContext {
  const logger = makeLogger();
  const transport = { connectionInfo: vi.fn(), listenAddress: vi.fn() };
  const platform = {
    logger,
    cache: {},
    hasResourceBroker: false,
    getAdapter: vi.fn((name: string) =>
      name === "serviceTransport" ? transport : undefined,
    ),
  };
  return {
    platform,
    logger,
    port: 4000,
    host: "127.0.0.1",
    netOffset: 0,
    runtime: {},
    platformRoot: "/platform",
    projectRoot: "/project",
    ...overrides,
  } as unknown as ServiceContext;
}

describe("gateway listen port", () => {
  beforeEach(() => {
    mocks.loadGatewayConfig.mockReset();
    mocks.createServer.mockReset();
    mocks.listen.mockReset().mockResolvedValue("listening");
    mocks.createServer.mockResolvedValue({
      listen: mocks.listen,
      close: vi.fn().mockResolvedValue(undefined),
    });
    mocks.loadGatewayConfig.mockResolvedValue({
      port: 4321,
      host: "127.0.0.1",
      upstreams: {},
      access: { mode: "local" },
    });
  });

  it("listens on config.port + ctx.netOffset", async () => {
    await setup(makeContext({ netOffset: 10 }));

    expect(mocks.listen).toHaveBeenCalledWith({
      port: 4331,
      host: "127.0.0.1",
    });
  });

  it("ignores ctx.port: config.port wins over the launcher-resolved port", async () => {
    await setup(makeContext({ port: 9999, netOffset: 10 }));

    expect(mocks.listen).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4331 }),
    );
  });

  it("passes the effective listen port to createServer", async () => {
    await setup(makeContext({ netOffset: 10 }));

    expect(mocks.createServer.mock.calls[0]![0]).toMatchObject({ port: 4331 });
  });
});
