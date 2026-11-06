/**
 * Tests for JWT secret validation in bootstrap (H6 security fix).
 * Bootstrap is otherwise hard to unit-test (requires full platform),
 * so we test the validation logic through environment variable behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockReadInstalledIdentity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Capture original env
const originalEnv = { ...process.env };

// Mock all heavy bootstrap deps before importing bootstrap
vi.mock("@kb-labs/core-platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kb-labs/core-platform")>()),
  GATEWAY_SERVICE_NETWORK: {
    serviceId: "gateway",
    portEnvVar: "GATEWAY_PORT",
    defaultPort: 4000,
    hostEnvVar: "GATEWAY_HOST",
    defaultHost: "0.0.0.0",
  },
  logDiagnosticEvent: vi.fn(),
  createErrorEnvelope: (code: string, options: { cause?: string; hint?: string } = {}) => ({ code, ...options }),
  ErrorEnvelopeError: class ErrorEnvelopeError extends Error {
    constructor(envelope: { code: string; cause?: string; hint?: string }) {
      super(`${envelope.code}: ${envelope.cause} Hint: ${envelope.hint}`);
    }
  },
  readInstalledPlatformIdentity: mockReadInstalledIdentity,
}));

vi.mock("@kb-labs/core-runtime", () => ({
  resolveDeploymentTopology: () => 'local',
  requireProjectContext: (projectRoot: string | undefined) => {
    if (!projectRoot) throw new Error('Project root required by test fixture');
    return projectRoot;
  },
  platform: {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      }),
      forComponent: () => ({
        forOperation: () => ({ info: vi.fn(), warn: vi.fn() }),
      }),
    },
    cache: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), clear: vi.fn() },
    getAdapter: vi.fn().mockImplementation((name: string) => {
      if (name === "serviceTransport") {
        return { connectionInfo: vi.fn(), call: vi.fn(), stream: vi.fn() };
      }
      return null;
    }),
    hasResourceBroker: false,
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@kb-labs/shared-daemon", () => ({
  requireEnvironmentSecret: (variable: string) => {
    const value = process.env[variable];
    if (!value) { throw new Error(`KB_CONFIG_SECRET_MISSING: The configuration references ${variable}, which has no value. Hint: set ${variable} in the deployment secret configuration, then restart the service.`); }
    return value;
  },
  runService: vi.fn().mockImplementation(async (config) => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
      forComponent: vi.fn(),
      forOperation: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    logger.forComponent.mockReturnValue(logger);
    logger.forOperation.mockReturnValue(logger);

    return config.setup({
      platform: {
        logger,
        cache: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), clear: vi.fn() },
        getAdapter: vi.fn().mockImplementation((name: string) => {
          if (name === "serviceTransport") {
            return { connectionInfo: vi.fn(), call: vi.fn(), stream: vi.fn() };
          }
          return undefined;
        }),
        hasResourceBroker: false,
      },
      projectRoot: "/tmp/kb-project",
      platformRoot: "/tmp/kb-platform",
      port: 4000,
      host: "127.0.0.1",
      logger,
      runtime: { effectiveConfig: { platform: { deployment: { topology: 'local' } } } },
      netOffset: 0,
    });
  }),
}));

vi.mock("../config.js", () => ({
  loadGatewayConfig: vi.fn().mockResolvedValue({
    port: 4000,
    upstreams: {},
    staticTokens: {},
  }),
}));

vi.mock("../server.js", () => ({
  createServer: vi.fn().mockResolvedValue({
    listen: vi.fn().mockResolvedValue("http://localhost:4000"),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../hosts/registry.js", () => ({
  HostRegistry: class {
    restore = vi.fn().mockResolvedValue(0);
  },
}));

vi.mock("@kb-labs/gateway-core", () => ({
  HostStore: vi.fn(),
}));

describe("bootstrap — JWT secret validation (H6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadInstalledIdentity.mockResolvedValue(undefined);
    // Reset env to original state before each test
    process.env = { ...originalEnv };
    delete process.env.GATEWAY_JWT_SECRET;
    process.env.GATEWAY_INTERNAL_SECRET = 'gateway-internal-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when NODE_ENV=production and GATEWAY_JWT_SECRET is not set", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.GATEWAY_JWT_SECRET;

    const { bootstrap } = await import("../bootstrap.js");
    await expect(bootstrap("/tmp/test")).rejects.toThrow("GATEWAY_JWT_SECRET");
  });

  it('fails fast with the catalog diagnostic when the shared internal secret is missing in development', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.GATEWAY_INTERNAL_SECRET;

    const { bootstrap } = await import('../bootstrap.js');
    await expect(bootstrap('/tmp/test')).rejects.toThrow(
      'KB_CONFIG_SECRET_MISSING: The configuration references GATEWAY_INTERNAL_SECRET, which has no value. Hint: set GATEWAY_INTERNAL_SECRET in the deployment secret configuration, then restart the service.',
    );
  });

  it("does not throw in dev mode when GATEWAY_JWT_SECRET is not set", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.GATEWAY_JWT_SECRET;

    const { bootstrap } = await import("../bootstrap.js");
    await expect(bootstrap("/tmp/test")).resolves.not.toThrow();
  });

  it("does not throw in production when GATEWAY_JWT_SECRET is set", async () => {
    process.env.NODE_ENV = "production";
    process.env.GATEWAY_JWT_SECRET = "a".repeat(64);

    const { bootstrap } = await import("../bootstrap.js");
    await expect(bootstrap("/tmp/test")).resolves.not.toThrow();
  });

  // case: PC-001.15
  it("refuses to start an installed Gateway when the launcher omitted its installation identity", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.KB_INSTALLATION_ID;
    mockReadInstalledIdentity.mockResolvedValue({ id: "stable-installation", gatewayUrl: "http://127.0.0.1:4000" });

    const { bootstrap } = await import("../bootstrap.js");
    await expect(bootstrap("/tmp/test")).rejects.toThrow("KB_INSTALL_RECEIPT_UNAVAILABLE");
    expect(mockReadInstalledIdentity).toHaveBeenCalledTimes(1);
  });
});
