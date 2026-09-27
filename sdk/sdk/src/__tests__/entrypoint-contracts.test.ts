import { describe, it, expect } from "vitest";

import * as SDK from "../index.js";
import * as Command from "../command/index.js";
import * as Manifest from "../manifest/index.js";
import * as Hooks from "../hooks/index.js";
import * as Contracts from "../contracts/index.js";
import * as Testing from "../testing/index.js";

function expectRequiredExports(
  moduleName: string,
  mod: Record<string, unknown>,
  required: readonly string[],
): void {
  const keys = new Set(Object.keys(mod));
  const missing = required.filter((name) => !keys.has(name));
  expect(missing, `${moduleName}: missing required exports`).toEqual([]);
}

describe("SDK Entrypoint Contracts", () => {
  it("publishes the platform LLM capability catalog", () => {
    expect(Object.keys(SDK.LLM_CAPABILITIES)).toEqual([
      "reasoning",
      "code",
      "fast",
      "vision",
      "document.input",
      "audio.input",
      "audio.transcription",
      "audio.output",
      "video.input",
    ]);
  });

  it("keeps required root exports", () => {
    expectRequiredExports("@kb-labs/sdk", SDK, [
      "defineCommand",
      "defineRoute",
      "defineAction",
      "defineWebhook",
      "defineWebSocket",
      "defineEventStream",
      "defineManifest",
      "defineCommandFlags",
      "createTestContext",
      "defineHandler",
      "defineError",
      "defineFlags",
      "defineEnv",
      "createTool",
      "combinePermissions",
      "getMonitoringSnapshot",
      "findRepoRoot",
      "LLM_CAPABILITIES",
    ]);
  });

  it("keeps required command entrypoint exports", () => {
    expectRequiredExports("@kb-labs/sdk/command", Command, [
      "defineCommand",
      "defineRoute",
      "defineAction",
      "defineWebhook",
      "defineWebSocket",
      "defineEventStream",
      "defineMessage",
      "isCLIHost",
      "isRESTHost",
      "isWorkflowHost",
      "isWebhookHost",
      "isWSHost",
      "MessageBuilder",
      "MessageRouter",
    ]);
  });

  it("keeps required manifest entrypoint exports", () => {
    expectRequiredExports("@kb-labs/sdk/manifest", Manifest, [
      "defineManifest",
      "defineCommandFlags",
      "generateExamples",
    ]);
  });

  it("keeps required hooks entrypoint exports", () => {
    expectRequiredExports("@kb-labs/sdk/hooks", Hooks, [
      "usePlatform",
      "isPlatformConfigured",
      "useConfig",
      "useLLM",
      "isLLMAvailable",
      "getLLMTier",
      "LLM_CAPABILITIES",
      "useEmbeddings",
      "isEmbeddingsAvailable",
      "useVectorStore",
      "isVectorStoreAvailable",
      "useAnalytics",
      "trackAnalyticsEvent",
      "useLogger",
      "useLoggerWithContext",
      "useStorage",
      "useCache",
      "isCacheAvailable",
    ]);
  });

  it("keeps required contracts entrypoint exports", () => {
    expectRequiredExports("@kb-labs/sdk/contracts", Contracts, [
      "DEFAULT_PERMISSIONS",
      "getLoggerMetadataFromHost",
      "noopUI",
      "noopTraceContext",
      "isManifestV3",
      "getHandlerPath",
      "getHandlerPermissions",
      "parseManifest",
      "validateManifest",
      "resolveHeaderPolicy",
      "createExecutionMeta",
    ]);
  });

  it("keeps required testing entrypoint exports", () => {
    expectRequiredExports("@kb-labs/sdk/testing", Testing, [
      "createTestContext",
      "createMockPluginContextV3",
      "testCommand",
      "mockLLM",
      "mockCache",
      "mockStorage",
      "mockLogger",
      "mockTool",
    ]);
  });
});
