/**
 * @kb-labs/cli-commands
 * Public surface: types, registry, TrieBackedRegistry, registerBuiltinCommands.
 * This package does not handle parsing argv/logging/exit.
 */
export * from "./registry/types";
export {
  registry,
  createRegistry,
  TrieBackedRegistry,
} from "./registry/service";
export type {
  SystemCommand,
  SystemGroup,
  RouteResult,
  RegistryDiagnostics,
} from "./registry/trie-router";
export { registerBuiltinCommands } from "./utils/register";
export * from "./utils/help-generator";
export { generateExamples, type ExampleCase } from "./utils/generate-examples";
export { TimingTracker } from "@kb-labs/shared-cli-ui";
export { discoverManifests } from "./registry/discover";
export { hello } from "./commands/system/hello";
export { health } from "./commands/system/health";
export { version } from "./commands/system/version";
export { createCompletionCommand } from "./commands/system/completion";

// Logs commands (agent-first log viewing and analysis)
export { projectAdd, projectList, projectShow, projectRemove } from "./commands/system/project";
export { logsDiagnose, logsContext, logsSummarize, logsQuery, logsSearch, logsGet, logsStats } from "./commands/system/logs";

export { generateCommandSchema } from "./presentation/schema-generator";
