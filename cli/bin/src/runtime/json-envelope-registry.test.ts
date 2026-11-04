import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerBuiltinCommands,
  registerBuiltinSystemCommands,
  registry,
  type RouteResult,
} from "@kb-labs/cli-commands";
import { createProjectRegistry } from "@kb-labs/core-project-registry";
import { createErrorEnvelope } from "@kb-labs/core-platform";
import { createJsonPresenter } from '@kb-labs/cli-runtime';
import type { LoadPlatformConfigResult } from '@kb-labs/core-runtime';
import { createPlatformConfigFixture } from './__tests__/fixtures/platform-config.js';

const mocks = vi.hoisted(() => {
  const logger = {
    trace(message: string) {
      process.stderr.write(`[trace] ${message}\n`);
    },
    debug(message: string) {
      process.stderr.write(`[debug] ${message}\n`);
    },
    info(message: string) {
      process.stderr.write(`[info] ${message}\n`);
    },
    warn(message: string) {
      process.stderr.write(`[warn] ${message}\n`);
    },
    error(message: string) {
      process.stderr.write(`[error] ${message}\n`);
    },
    fatal(message: string) {
      process.stderr.write(`[fatal] ${message}\n`);
    },
    flush: async () => {},
    child() {
      return logger;
    },
  };
  const corePlatform = {
    logger,
    logs: {
      query: vi.fn().mockResolvedValue({ logs: [] }),
      getById: vi.fn().mockResolvedValue({
        id: "fixture-log-id",
        timestamp: Date.now(),
        level: "info",
        source: "registry-test",
        message: "fixture log record",
        fields: { level: 30 },
      }),
      search: vi.fn().mockResolvedValue({ logs: [] }),
      getStats: vi.fn().mockResolvedValue({}),
      getCapabilities: vi.fn().mockResolvedValue({}),
    },
  };
  return {
    loadPlatformConfiguration: vi.fn(),
    initializePlatform: vi.fn(),
    resolveProjectConfig: vi.fn(),
    logger,
    platform: { logger, getAdapter: () => undefined },
    corePlatform,
    platformSync: vi.fn().mockResolvedValue({
      ok: true,
      status: "success",
      mode: "validate",
      checked: 0,
      missing: [],
      mismatched: [],
      installed: [],
      errors: [],
      lockMissing: true,
    }),
  };
});

vi.mock("./platform-init.js", () => ({
  loadPlatformConfiguration: mocks.loadPlatformConfiguration,
  initializePlatform: mocks.initializePlatform,
  resolveProjectConfig: mocks.resolveProjectConfig,
}));
vi.mock("@kb-labs/core-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kb-labs/core-runtime")>()),
  platform: mocks.corePlatform,
  platformSync: mocks.platformSync,
}));
vi.mock("@kb-labs/cli-runtime/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kb-labs/cli-runtime/gateway")>()),
  resolveActiveGateway: async () => ({ gatewayUrl: "https://gateway.test" }),
}));

import { executeCli } from "./bootstrap.js";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
);
let isolatedHome: string;
let fixtureProjectId: string;
let fixtureCatalogs: LoadPlatformConfigResult['catalog'][] = [];
let rejectUnauthenticatedWebhookRequests = false;
const originalEnvironment = {
  HOME: process.env.HOME,
  KB_HOME: process.env.KB_HOME,
  KB_PLATFORM_ROOT: process.env.KB_PLATFORM_ROOT,
  KB_PROJECT_ROOT: process.env.KB_PROJECT_ROOT,
  KB_NET_OFFSET: process.env.KB_NET_OFFSET,
  KB_LOG_LEVEL: process.env.KB_LOG_LEVEL,
  KB_LOG_STREAM: process.env.KB_LOG_STREAM,
  CLI_VERSION: process.env.CLI_VERSION,
};
const originalFetch = globalThis.fetch;
const logger = {
  trace(message: string) {
    process.stderr.write(`[trace] ${message}\n`);
  },
  debug(message: string) {
    process.stderr.write(`[debug] ${message}\n`);
  },
  info(message: string) {
    process.stderr.write(`[info] ${message}\n`);
  },
  warn(message: string) {
    process.stderr.write(`[warn] ${message}\n`);
  },
  error(message: string) {
    process.stderr.write(`[error] ${message}\n`);
  },
  fatal(message: string) {
    process.stderr.write(`[fatal] ${message}\n`);
  },
  flush: async () => {},
  child() {
    return logger;
  },
};
const platform = mocks.platform;

type SystemCommandFixture = Extract<RouteResult, { type: "system-cmd" }>["cmd"];
type PluginCommandFixture = Extract<
  RouteResult,
  { type: "command" }
>["command"];

type RegistryCommandFixture = {
  segments: string[];
  kind: "system" | "plugin";
  system?: SystemCommandFixture;
  plugin?: PluginCommandFixture;
};

function commandPaths(): RegistryCommandFixture[] {
  const queue = registry.complete([]).map((entry) => entry.split(" "));
  const commands = new Map<string, Omit<RegistryCommandFixture, "segments">>();
  while (queue.length > 0) {
    const segments = queue.shift()!;
    const route = registry.resolve(segments);
    if (route.type === "system-cmd") {
      commands.set(segments.join(" "), { kind: "system", system: route.cmd });
      continue;
    }
    if (route.type === "command") {
      commands.set(route.command.manifest.segments.join(" "), {
        kind: "plugin",
        plugin: route.command,
      });
      continue;
    }
    const children =
      route.type === "system-group"
        ? route.group.commands.map((command) => command.name)
        : route.type === "group"
          ? route.childKeys
          : [];
    for (const child of children) queue.push([...segments, child]);
  }
  return [...commands]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([command, info]) => ({ segments: command.split(" "), ...info }));
}

describe("JSON envelope coverage for the live CLI registry", () => {
  beforeAll(async () => {
    isolatedHome = await mkdtemp(
      path.join(os.tmpdir(), "kb-cli-json-registry-"),
    );
    process.env.HOME = isolatedHome;
    process.env.KB_HOME = path.join(isolatedHome, ".kb");
    delete process.env.KB_PLATFORM_ROOT;
    delete process.env.KB_PROJECT_ROOT;
    delete process.env.KB_NET_OFFSET;
    process.env.KB_LOG_LEVEL = "silent";
    process.env.KB_LOG_STREAM = "stderr";
    process.env.CLI_VERSION = "2.120.1";
    globalThis.fetch = vi.fn((input: string | URL | Request) => {
      if (
        rejectUnauthenticatedWebhookRequests &&
        String(input).includes("/api/v1/webhooks")
      ) {
        const error = createErrorEnvelope("KB_AUTH_REQUIRED", {
          details: { gatewayUrl: "https://gateway.test" },
        });
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error }), { status: 401 }),
        );
      }
      if (String(input).includes("/api/v1/webhooks/history/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                record: {
                  webhookId: "fixture-webhook-id",
                  project: "local",
                  receivedAt: "2026-10-16T08:00:00.000Z",
                  pluginId: "@kb-labs/fixture",
                  event: "fixture",
                  handler: "./handler.js#default",
                  instanceId: null,
                  outcome: { type: "delivered" },
                  durationMs: 1,
                  correlationId: "fixture-request",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (String(input).includes("/health/adapters")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, data: { webhooks: [], tokens: [] } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }) as typeof fetch;
    const projects = await createProjectRegistry({ env: process.env });
    fixtureProjectId = (await projects.add(workspaceRoot)).project.id;
    const rawConfig = { gateway: { access: { mode: "local" } } };
    const platformConfig = await createPlatformConfigFixture({
      cwd: workspaceRoot,
      home: isolatedHome,
      rawConfig,
      registeredProjects: [workspaceRoot],
    });
    fixtureCatalogs.push(platformConfig.catalog);
    mocks.loadPlatformConfiguration.mockResolvedValue(platformConfig);
    mocks.initializePlatform.mockImplementation(async (config) => ({
      ...config,
      platform,
    }));
    const projectConfig = await createPlatformConfigFixture({
      cwd: workspaceRoot,
      home: isolatedHome,
      rawConfig,
      projectScope: 'required',
      registeredProjects: [workspaceRoot],
    });
    fixtureCatalogs.push(projectConfig.catalog);
    mocks.resolveProjectConfig.mockResolvedValue(projectConfig);
    registerBuiltinSystemCommands();
    await registerBuiltinCommands({
      cwd: workspaceRoot,
      env: process.env,
      logger,
      platformRoot: workspaceRoot,
      projectRoot: workspaceRoot,
      resolvePlatformVersion: async () => 'test',
    });
  });

  afterAll(async () => {
    mocks.initializePlatform.mockReset();
    globalThis.fetch = originalFetch;
    await Promise.all(fixtureCatalogs.map((catalog) => catalog.dispose()));
    fixtureCatalogs = [];
    await rm(isolatedHome, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // case: S-203.1, S-203.2
  it("serializes the live command registry through the CLI result envelope", async () => {
    const commands = commandPaths();
    expect(commands.some((command) => command.kind === "system")).toBe(true);
    expect(commands.length).toBeGreaterThan(0);

    const fixtureManifest = path.join(isolatedHome, "fixture-manifest.json");
    const fixtureManifestContent = JSON.stringify({
      schema: "kb.adapter/1",
      manifestVersion: 3,
      id: "@fixture/registry-test",
      version: "1.0.0",
      displayName: "Registry test fixture",
      description: "Read-only CLI JSON coverage fixture",
      cli: { commands: [] },
    });
    await writeFile(fixtureManifest, fixtureManifestContent, "utf8");

    const runAndCapture = async (argv: string[], cwd = workspaceRoot) => {
      const stdoutConsole = [
        vi.spyOn(console, "log").mockImplementation(() => {}),
        vi.spyOn(console, "info").mockImplementation(() => {}),
        vi.spyOn(console, "debug").mockImplementation(() => {}),
      ];
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const stderrConsole = [
        vi.spyOn(console, "warn").mockImplementation((...args) => {
          process.stderr.write(`${args.map(String).join(" ")}\n`);
        }),
        vi.spyOn(console, "error").mockImplementation((...args) => {
          process.stderr.write(`${args.map(String).join(" ")}\n`);
        }),
        vi.spyOn(console, "trace").mockImplementation((...args) => {
          process.stderr.write(`${args.map(String).join(" ")}\n`);
        }),
      ];
      const previousCwd = process.cwd();
      try {
        process.chdir(cwd);
        const exitCode = await executeCli(argv, {
          cwd,
          env: process.env,
          registry,
          resultWriter: (value, pretty = false) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, pretty ? 2 : undefined)}\n`),
          registerBuiltinCommands: () => {},
          createJsonPresenter: () => createJsonPresenter((value) => { process.stdout.write(`${JSON.stringify(value)}\n`); }),
        });
        const stdoutRecords = [
          ...stdoutConsole.flatMap((spy) =>
            spy.mock.calls.map((args) => args.map(String).join(" ")),
          ),
          ...stdout.mock.calls.map(([record]) => String(record)),
        ];
        const stderrRecords = stderr.mock.calls.map(([record]) =>
          String(record),
        );
        expect(stdoutRecords, argv.join(" ")).toHaveLength(1);
        expect(
          stderrRecords.every((record) => typeof record === "string"),
          argv.join(" "),
        ).toBe(true);
        const result = JSON.parse(stdoutRecords[0]!) as Record<string, unknown>;
        expect(typeof result.ok, argv.join(" ")).toBe("boolean");
        return { exitCode, result, stdoutRecords, stderrRecords };
      } finally {
        process.chdir(previousCwd);
        for (const spy of stdoutConsole) spy.mockRestore();
        stdout.mockRestore();
        stderr.mockRestore();
        for (const spy of stderrConsole) spy.mockRestore();
      }
    };

    for (const command of commands) {
      if (command.kind === "system") {
        const system = command.system!;
        if ("safeArgs" in system.jsonTest) {
          expect(
            system.jsonTest.safeArgs.every(
              (argument) => typeof argument === "string",
            ),
            command.segments.join(" "),
          ).toBe(true);
          const safeArgs = system.jsonTest.safeArgs.map((argument) => {
            if (argument === "__fixture_project_id__") return fixtureProjectId;
            if (argument === "__fixture_manifest__") return fixtureManifest;
            if (argument === "__fixture_workflow__") {
              return path.join(
                workspaceRoot,
                "services/workflow/entry/src/__tests__/cli/fixtures/lint/valid.yml",
              );
            }
            if (argument.startsWith("__fixture_")) return `${argument}-id`;
            return argument;
          });
          const commandCwd = command.segments.join(" ") === "workflow create"
            ? await mkdtemp(path.join(isolatedHome, "workflow-create-"))
            : workspaceRoot;
          let valid: Awaited<ReturnType<typeof runAndCapture>>;
          try {
            valid = await runAndCapture(
              [...command.segments, ...safeArgs, "--json"],
              commandCwd,
            );
          } finally {
            if (commandCwd !== workspaceRoot) {
              await rm(commandCwd, { recursive: true, force: true });
            }
          }
          expect(
            valid.exitCode,
            `${command.segments.join(" ")}: ${JSON.stringify(valid.result)}`,
          ).toBe(0);
          expect(valid.result).toMatchObject({
            ok: true,
            data: expect.anything(),
          });
          expect(
            valid.stderrRecords.length,
            command.segments.join(" "),
          ).toBeGreaterThan(0);
        } else {
          expect(
            system.jsonTest.noSafeValidPath.trim(),
            command.segments.join(" "),
          ).not.toBe("");
          const help = await runAndCapture([
            ...command.segments,
            "--help",
            "--json",
          ]);
          expect(help.exitCode, command.segments.join(" ")).toBe(0);
          expect(help.result).toMatchObject({ ok: true });
        }

        const invalid = await runAndCapture([
          ...command.segments,
          "--__kb_registry_invalid_fixture__",
          "--json",
        ]);
        expect(invalid.exitCode, command.segments.join(" ")).toBe(2);
        expect(invalid.result).toMatchObject({
          ok: false,
          error: {
            code: expect.stringMatching(/^KB_/),
            hint: expect.any(String),
          },
        });

        if (command.segments.join(" ") === "webhook list") {
          rejectUnauthenticatedWebhookRequests = true;
          const unauthenticated = await runAndCapture([
            ...command.segments,
            "--json",
          ]);
          expect(unauthenticated.exitCode).toBe(1);
          expect(unauthenticated.result).toMatchObject({
            ok: false,
            error: {
              code: "KB_AUTH_REQUIRED",
              hint: createErrorEnvelope("KB_AUTH_REQUIRED", {
                details: { gatewayUrl: "https://gateway.test" },
              }).hint,
              details: { gatewayUrl: "https://gateway.test" },
            },
          });
        }
      } else {
        const validHelp = await runAndCapture([
          ...command.segments,
          "--help",
          "--json",
        ]);
        expect(validHelp.exitCode, command.segments.join(" ")).toBe(0);
        expect(validHelp.result).toMatchObject({ ok: true });
        const invalidSegments = [...command.segments];
        invalidSegments[invalidSegments.length - 1] += "__unknown__";
        const invalid = await runAndCapture([...invalidSegments, "--json"]);
        expect(invalid.exitCode, invalidSegments.join(" ")).toBe(2);
        expect(invalid.result).toMatchObject({
          ok: false,
          error: { code: "KB_RUNTIME_UNKNOWN_COMMAND" },
        });
      }
    }
  }, 120_000);
});
