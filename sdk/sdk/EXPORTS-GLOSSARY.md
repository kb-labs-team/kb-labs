# SDK Exports Glossary

Auto-generated from SDK entrypoint surfaces. Do not edit manually.

Regenerate:

```bash
pnpm --filter @kb-labs/sdk docs:exports
```

## `@kb-labs/sdk`

Source: `src/index.ts`

Total exports: **294**

| Export | Kind | From |
|---|---|---|
| `ActionDefinition` | `type` | `./command/index.js` |
| `ActionHandler` | `type` | `./command/index.js` |
| `AdapterConfigError` | `value` | `@kb-labs/core-platform` |
| `AdapterCredentialsMissingError` | `value` | `@kb-labs/core-platform` |
| `AdapterMode` | `type` | `@kb-labs/core-runtime` |
| `AdapterOperationError` | `value` | `@kb-labs/core-platform` |
| `AdapterSlotStatus` | `type` | `@kb-labs/core-runtime` |
| `AdapterUnavailableError` | `value` | `@kb-labs/core-platform` |
| `ArrayFlagSchema` | `type` | `@kb-labs/shared-command-kit` |
| `ArtifactInfo` | `type` | `@kb-labs/shared-cli-ui` |
| `ArtifactMeta` | `type` | `@kb-labs/core-platform` |
| `ArtifactWriteOptions` | `type` | `@kb-labs/core-platform` |
| `BaseDocument` | `type` | `@kb-labs/core-platform` |
| `BooleanFlagSchema` | `type` | `@kb-labs/shared-command-kit` |
| `buildConfirmationSignal` | `value` | `@kb-labs/shared-cli-ui` |
| `BulkOp` | `type` | `@kb-labs/core-platform` |
| `BulkResult` | `type` | `@kb-labs/core-platform` |
| `ciEnvironmentPreset` | `value` | `@kb-labs/perm-presets` |
| `ClassifiedFailure` | `type` | `./contracts/index.js` |
| `classifyFailure` | `value` | `@kb-labs/core-retry` |
| `CleanupFn` | `type` | `./contracts/index.js` |
| `CliGroup` | `type` | `./manifest/index.js` |
| `CLIInput` | `type` | `./command/index.js` |
| `cmd` | `value` | `./manifest/index.js` |
| `CmdBuilder` | `type` | `./manifest/index.js` |
| `ColorFunction` | `type` | `./contracts/index.js` |
| `Colors` | `type` | `./contracts/index.js` |
| `combinePermissions` | `value` | `@kb-labs/perm-presets` |
| `combinePresets` | `value` | `@kb-labs/perm-presets` |
| `CommandDefinition` | `type` | `./command/index.js` |
| `CommandError` | `type` | `./contracts/index.js` |
| `CommandFailure` | `type` | `./contracts/index.js` |
| `CommandHandler` | `type` | `./command/index.js` |
| `CommandResult` | `type` | `./contracts/index.js` |
| `commonErrors` | `value` | `@kb-labs/shared-command-kit` |
| `ConfirmationRequired` | `type` | `@kb-labs/shared-cli-ui` |
| `confirmDestructive` | `value` | `@kb-labs/shared-cli-ui` |
| `ContextForHost` | `type` | `./utils/index.js` |
| `createErrorEnvelope` | `value` | `@kb-labs/core-platform` |
| `createManifest` | `value` | `./manifest/index.js` |
| `createTestContext` | `value` | `./test/index.js` |
| `CreateTestContextOptions` | `type` | `./test/index.js` |
| `createTool` | `value` | `@kb-labs/shared-tool-kit` |
| `decideRetry` | `value` | `@kb-labs/core-retry` |
| `DEFAULT_TRANSIENT_RETRY_POLICY` | `value` | `@kb-labs/core-retry` |
| `defineAction` | `value` | `./command/index.js` |
| `defineCommand` | `value` | `./command/index.js` |
| `defineCommandFlags` | `value` | `./manifest/index.js` |
| `DefinedJob` | `type` | `@kb-labs/shared-command-kit` |
| `defineEnv` | `value` | `@kb-labs/shared-cli-ui` |
| `defineError` | `value` | `@kb-labs/shared-command-kit` |
| `defineEventStream` | `value` | `./command/index.js` |
| `defineFlags` | `value` | `./manifest/flags.js` |
| `defineHandler` | `value` | `@kb-labs/shared-command-kit` |
| `defineJob` | `value` | `@kb-labs/shared-command-kit` |
| `defineManifest` | `value` | `./manifest/index.js` |
| `defineMessage` | `value` | `./command/index.js` |
| `defineRoute` | `value` | `./command/index.js` |
| `defineWebhook` | `value` | `./command/index.js` |
| `defineWebSocket` | `value` | `./command/index.js` |
| `DegradedLevel` | `type` | `@kb-labs/core-runtime` |
| `DegradedOptions` | `type` | `@kb-labs/core-runtime` |
| `DegradedStatus` | `type` | `@kb-labs/core-runtime` |
| `DELETE` | `value` | `./manifest/index.js` |
| `deriveProjectId` | `value` | `@kb-labs/core-project-registry` |
| `DestructiveAction` | `type` | `@kb-labs/shared-cli-ui` |
| `DestructiveSeverity` | `type` | `@kb-labs/shared-cli-ui` |
| `discoverSubRepoPaths` | `value` | `@kb-labs/core-sys` |
| `displayArtifacts` | `value` | `@kb-labs/shared-cli-ui` |
| `displayArtifactsCompact` | `value` | `@kb-labs/shared-cli-ui` |
| `displaySingleArtifact` | `value` | `@kb-labs/shared-cli-ui` |
| `DocumentFilter` | `type` | `@kb-labs/core-platform` |
| `DocumentUpdate` | `type` | `@kb-labs/core-platform` |
| `EnsureCollectionOpts` | `type` | `@kb-labs/core-platform` |
| `EnvDefinition` | `type` | `@kb-labs/shared-cli-ui` |
| `EnvSchema` | `type` | `@kb-labs/shared-cli-ui` |
| `ErrorDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `ErrorDefinitions` | `type` | `@kb-labs/shared-command-kit` |
| `errorResult` | `value` | `@kb-labs/shared-cli-ui` |
| `EventStreamDefinition` | `type` | `./command/index.js` |
| `EventStreamHandler` | `type` | `./command/index.js` |
| `ExampleCase` | `type` | `./manifest/index.js` |
| `ExecOptions` | `type` | `./contracts/index.js` |
| `ExecResult` | `type` | `./contracts/index.js` |
| `ExecutionTarget` | `type` | `./contracts/index.js` |
| `ExtractHostContext` | `type` | `./utils/index.js` |
| `FailureClassificationContext` | `type` | `./contracts/index.js` |
| `FailureInfo` | `type` | `./contracts/index.js` |
| `FailureKind` | `type` | `./contracts/index.js` |
| `FailureSource` | `type` | `./contracts/index.js` |
| `FeedbackRecord` | `type` | `@kb-labs/core-platform` |
| `FeedbackType` | `type` | `@kb-labs/core-platform` |
| `FileFeedbackStore` | `value` | `@kb-labs/core-platform` |
| `FileFeedbackStoreOptions` | `type` | `@kb-labs/core-platform` |
| `FileHistoryStore` | `value` | `@kb-labs/core-platform` |
| `FileHistoryStoreOptions` | `type` | `@kb-labs/core-platform` |
| `FilterOperators` | `type` | `@kb-labs/core-platform` |
| `FindOptions` | `type` | `@kb-labs/core-platform` |
| `findRegisteredProjectContainingPathSync` | `value` | `@kb-labs/core-project-registry` |
| `findRepoRoot` | `value` | `@kb-labs/core-sys` |
| `FlagSchema` | `type` | `@kb-labs/shared-command-kit` |
| `FlagSchemaDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `FlagSchemaWithInfer` | `type` | `@kb-labs/shared-command-kit` |
| `FlagType` | `type` | `@kb-labs/shared-command-kit` |
| `FlagValidationError` | `type` | `@kb-labs/shared-command-kit` |
| `formatCommandHelp` | `value` | `@kb-labs/shared-cli-ui` |
| `formatError` | `value` | `@kb-labs/shared-cli-ui` |
| `fullEnvPreset` | `value` | `@kb-labs/perm-presets` |
| `generateExamples` | `value` | `./manifest/index.js` |
| `GET` | `value` | `./manifest/index.js` |
| `getAdapterStatus` | `value` | `@kb-labs/core-runtime` |
| `getAdapterStatusFor` | `value` | `@kb-labs/core-runtime` |
| `getDegradedStatus` | `value` | `@kb-labs/core-runtime` |
| `getHostServiceAddress` | `value` | `@kb-labs/core-platform` |
| `getLLMTier` | `value` | `./hooks/index.js` |
| `getMonitoringSnapshot` | `value` | `@kb-labs/core-runtime` |
| `gitWorkflowPreset` | `value` | `@kb-labs/perm-presets` |
| `group` | `value` | `./manifest/index.js` |
| `handleError` | `value` | `@kb-labs/shared-cli-ui` |
| `Handler` | `type` | `@kb-labs/shared-command-kit` |
| `HandlerDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `HandlerRef` | `type` | `./manifest/index.js` |
| `HistoryFindOptions` | `type` | `@kb-labs/core-platform` |
| `HistoryRecord` | `type` | `@kb-labs/core-platform` |
| `HostContext` | `type` | `./contracts/index.js` |
| `HostServiceAddressError` | `value` | `@kb-labs/core-platform` |
| `HostServiceEnvironment` | `type` | `@kb-labs/core-platform` |
| `HostServiceId` | `type` | `@kb-labs/core-platform` |
| `HostType` | `type` | `./contracts/index.js` |
| `IAnalytics` | `type` | `@kb-labs/core-platform` |
| `IArtifacts` | `type` | `@kb-labs/core-platform` |
| `ICache` | `type` | `@kb-labs/core-platform` |
| `IDocumentDatabase` | `type` | `@kb-labs/core-platform` |
| `IDocumentTransaction` | `type` | `@kb-labs/core-platform` |
| `IEmbeddings` | `type` | `@kb-labs/core-platform` |
| `IFeedbackStore` | `type` | `@kb-labs/core-platform` |
| `IHistoryStore` | `type` | `@kb-labs/core-platform` |
| `IKVStore` | `type` | `@kb-labs/core-platform` |
| `ILLM` | `type` | `@kb-labs/core-platform` |
| `ILogger` | `type` | `@kb-labs/core-platform` |
| `IndexSpec` | `type` | `@kb-labs/core-platform` |
| `InferFlags` | `type` | `@kb-labs/shared-command-kit` |
| `infoResult` | `value` | `@kb-labs/shared-cli-ui` |
| `INotifierChannel` | `type` | `@kb-labs/core-platform` |
| `isCacheAvailable` | `value` | `./hooks/index.js` |
| `isCLIHost` | `value` | `./command/index.js` |
| `isDocumentDatabaseAvailable` | `value` | `./hooks/index.js` |
| `isEmbeddingsAvailable` | `value` | `./hooks/index.js` |
| `IServiceTransport` | `type` | `@kb-labs/core-platform` |
| `isKVStoreAvailable` | `value` | `./hooks/index.js` |
| `isLLMAvailable` | `value` | `./hooks/index.js` |
| `isPlatformConfigured` | `value` | `./hooks/index.js` |
| `isRESTHost` | `value` | `./command/index.js` |
| `IStorage` | `type` | `@kb-labs/core-platform` |
| `isVectorStoreAvailable` | `value` | `./hooks/index.js` |
| `isWebhookHost` | `value` | `./command/index.js` |
| `isWorkflowHost` | `value` | `./command/index.js` |
| `isWSHost` | `value` | `./command/index.js` |
| `IVectorStore` | `type` | `@kb-labs/core-platform` |
| `JobDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `JobHandler` | `type` | `@kb-labs/shared-command-kit` |
| `JobInput` | `type` | `@kb-labs/shared-command-kit` |
| `kbPlatformPreset` | `value` | `@kb-labs/perm-presets` |
| `ListData` | `type` | `@kb-labs/studio-ui-kit` |
| `ListItem` | `type` | `@kb-labs/studio-ui-kit` |
| `llmAccessPreset` | `value` | `@kb-labs/perm-presets` |
| `LLMMessage` | `type` | `@kb-labs/core-platform` |
| `LLMOptions` | `type` | `@kb-labs/core-platform` |
| `LLMResponse` | `type` | `@kb-labs/core-platform` |
| `LLMTier` | `type` | `./hooks/index.js` |
| `LLMTool` | `type` | `@kb-labs/core-platform` |
| `LLMToolCall` | `type` | `@kb-labs/core-platform` |
| `LLMToolCallOptions` | `type` | `@kb-labs/core-platform` |
| `LLMToolCallResponse` | `type` | `@kb-labs/core-platform` |
| `Loader` | `type` | `@kb-labs/shared-cli-ui` |
| `ManifestV3` | `type` | `./contracts/index.js` |
| `MemoryFeedbackStore` | `value` | `@kb-labs/core-platform` |
| `MemoryHistoryStore` | `value` | `@kb-labs/core-platform` |
| `mergeCliGroups` | `value` | `./manifest/index.js` |
| `MessageBuilder` | `value` | `./command/index.js` |
| `MessageRouter` | `value` | `./command/index.js` |
| `MetricData` | `type` | `@kb-labs/studio-ui-kit` |
| `metricsList` | `value` | `@kb-labs/shared-cli-ui` |
| `minimalPreset` | `value` | `@kb-labs/perm-presets` |
| `MonitoringOptions` | `type` | `@kb-labs/core-runtime` |
| `MonitoringSnapshot` | `type` | `@kb-labs/core-runtime` |
| `NotificationAudience` | `type` | `@kb-labs/core-platform` |
| `NotificationCapability` | `type` | `@kb-labs/core-platform` |
| `NotificationEvent` | `type` | `@kb-labs/core-platform` |
| `NotificationFilter` | `type` | `@kb-labs/core-platform` |
| `NotificationSeverity` | `type` | `@kb-labs/core-platform` |
| `NotifierDeliveryEvent` | `type` | `@kb-labs/core-platform` |
| `npmPublishPreset` | `value` | `@kb-labs/perm-presets` |
| `NumberFlagSchema` | `type` | `@kb-labs/shared-command-kit` |
| `OutputSection` | `type` | `./contracts/index.js` |
| `parseEnvFromRuntime` | `value` | `@kb-labs/shared-cli-ui` |
| `parseJsonc` | `value` | `@kb-labs/core-config` |
| `PATCH` | `value` | `./manifest/index.js` |
| `PermissionPreset` | `type` | `@kb-labs/perm-presets` |
| `PermissionSpec` | `type` | `./contracts/index.js` |
| `PlatformConfigError` | `value` | `@kb-labs/core-platform` |
| `PlatformServices` | `type` | `./contracts/index.js` |
| `PluginAPI` | `type` | `./contracts/index.js` |
| `PluginCommandContextV3` | `type` | `./contracts/index.js` |
| `PluginContextDescriptor` | `type` | `./contracts/index.js` |
| `PluginContextV3` | `type` | `./contracts/index.js` |
| `PluginError` | `value` | `@kb-labs/plugin-contracts` |
| `PluginHandlerUIFacade` | `type` | `./contracts/index.js` |
| `PluginId` | `type` | `./manifest/index.js` |
| `POST` | `value` | `./manifest/index.js` |
| `PresetBuilder` | `type` | `@kb-labs/perm-presets` |
| `presets` | `value` | `@kb-labs/perm-presets` |
| `ProjectEntry` | `type` | `@kb-labs/core-contracts` |
| `ProjectOpts` | `type` | `@kb-labs/core-platform` |
| `ProjectServiceConnectionInfo` | `type` | `@kb-labs/core-platform` |
| `PUT` | `value` | `./manifest/index.js` |
| `renderDestructiveMessage` | `value` | `@kb-labs/shared-cli-ui` |
| `requireProjectContext` | `value` | `@kb-labs/core-project-registry` |
| `resolveRuntimeStatePath` | `value` | `@kb-labs/core-project-registry` |
| `RestBase` | `type` | `./manifest/index.js` |
| `RestInput` | `type` | `@kb-labs/shared-command-kit` |
| `rethrowForRest` | `value` | `@kb-labs/shared-cli-ui` |
| `RetryDecision` | `type` | `./contracts/index.js` |
| `RetryPolicyConfig` | `type` | `./contracts/index.js` |
| `RetrySafety` | `type` | `./contracts/index.js` |
| `RichSectionItem` | `type` | `@kb-labs/shared-cli-ui` |
| `RouteDefinition` | `type` | `./command/index.js` |
| `RouteHandler` | `type` | `./command/index.js` |
| `RuntimeAPI` | `type` | `./contracts/index.js` |
| `SafeValidationResult` | `type` | `@kb-labs/shared-command-kit` |
| `SectionContent` | `type` | `@kb-labs/shared-cli-ui` |
| `sectionHeader` | `value` | `@kb-labs/shared-cli-ui` |
| `SectionItem` | `type` | `@kb-labs/shared-cli-ui` |
| `SelectData` | `type` | `@kb-labs/studio-ui-kit` |
| `SelectOptionItem` | `type` | `@kb-labs/studio-ui-kit` |
| `SemVer` | `type` | `./manifest/index.js` |
| `ServiceConnectionInfo` | `type` | `@kb-labs/core-platform` |
| `ServiceListenAddress` | `type` | `@kb-labs/core-platform` |
| `ServiceTransportHealth` | `type` | `@kb-labs/core-platform` |
| `ServiceTransportRequest` | `type` | `@kb-labs/core-platform` |
| `ServiceTransportResponse` | `type` | `@kb-labs/core-platform` |
| `ServiceTransportStream` | `type` | `@kb-labs/core-platform` |
| `SetOpts` | `type` | `@kb-labs/core-platform` |
| `ShellAPI` | `type` | `./contracts/index.js` |
| `sideBorderBox` | `value` | `@kb-labs/shared-cli-ui` |
| `SideBorderBoxOptions` | `type` | `@kb-labs/shared-cli-ui` |
| `SideBoxOptions` | `type` | `./contracts/index.js` |
| `SignalOpts` | `type` | `@kb-labs/core-platform` |
| `statusLine` | `value` | `@kb-labs/shared-cli-ui` |
| `StringFlagSchema` | `type` | `@kb-labs/shared-command-kit` |
| `StudioConfig` | `type` | `@kb-labs/plugin-contracts` |
| `StudioMenuEntry` | `type` | `@kb-labs/plugin-contracts` |
| `StudioPageEntry` | `type` | `@kb-labs/plugin-contracts` |
| `successResult` | `value` | `@kb-labs/shared-cli-ui` |
| `TableData` | `type` | `@kb-labs/studio-ui-kit` |
| `TableRow` | `type` | `@kb-labs/studio-ui-kit` |
| `TimingTracker` | `value` | `@kb-labs/shared-cli-ui` |
| `toErrorEnvelope` | `value` | `@kb-labs/core-platform` |
| `ToolDefinitionShape` | `type` | `@kb-labs/shared-tool-kit` |
| `ToolShape` | `type` | `@kb-labs/shared-tool-kit` |
| `ToolSpec` | `type` | `@kb-labs/shared-tool-kit` |
| `trackAnalyticsEvent` | `value` | `./hooks/index.js` |
| `TypedSender` | `type` | `./command/index.js` |
| `UIFacade` | `type` | `./contracts/index.js` |
| `useAnalytics` | `value` | `./hooks/index.js` |
| `useCache` | `value` | `./hooks/index.js` |
| `useConfig` | `value` | `./hooks/index.js` |
| `useDocumentDatabase` | `value` | `./hooks/index.js` |
| `useEmbeddings` | `value` | `./hooks/index.js` |
| `useEnv` | `value` | `./hooks/index.js` |
| `useKVStore` | `value` | `./hooks/index.js` |
| `useLLM` | `value` | `./hooks/index.js` |
| `UseLLMOptions` | `type` | `./hooks/index.js` |
| `useLoader` | `value` | `@kb-labs/shared-cli-ui` |
| `useLogger` | `value` | `./hooks/index.js` |
| `useLoggerWithContext` | `value` | `./hooks/index.js` |
| `usePlatform` | `value` | `./hooks/index.js` |
| `useStorage` | `value` | `./hooks/index.js` |
| `useVectorStore` | `value` | `./hooks/index.js` |
| `validationError` | `value` | `@kb-labs/shared-cli-ui` |
| `ValidationResult` | `type` | `@kb-labs/shared-command-kit` |
| `vectorStorePreset` | `value` | `@kb-labs/perm-presets` |
| `warningResult` | `value` | `@kb-labs/shared-cli-ui` |
| `webhook` | `value` | `./manifest/index.js` |
| `WebhookDefinition` | `type` | `./command/index.js` |
| `WebhookHandler` | `type` | `./command/index.js` |
| `WebSocketDefinition` | `type` | `./command/index.js` |
| `WebSocketHandler` | `type` | `./command/index.js` |
| `WebSocketHostContext` | `type` | `./contracts/index.js` |
| `WsBase` | `type` | `./manifest/index.js` |
| `WSInput` | `type` | `./contracts/index.js` |
| `WSLifecycleEvent` | `type` | `./contracts/index.js` |
| `WSMessage` | `type` | `./contracts/index.js` |
| `WSSender` | `type` | `./contracts/index.js` |

## `@kb-labs/sdk/command`

Source: `src/command/index.ts`

Total exports: **28**

| Export | Kind | From |
|---|---|---|
| `ActionDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `ActionHandler` | `type` | `@kb-labs/shared-command-kit` |
| `CLIInput` | `type` | `@kb-labs/shared-command-kit` |
| `CommandDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `CommandHandler` | `type` | `@kb-labs/shared-command-kit` |
| `defineAction` | `value` | `@kb-labs/shared-command-kit` |
| `defineCommand` | `value` | `@kb-labs/shared-command-kit` |
| `defineEventStream` | `value` | `@kb-labs/shared-command-kit` |
| `defineMessage` | `value` | `@kb-labs/shared-command-kit` |
| `defineRoute` | `value` | `@kb-labs/shared-command-kit` |
| `defineWebhook` | `value` | `@kb-labs/shared-command-kit` |
| `defineWebSocket` | `value` | `@kb-labs/shared-command-kit` |
| `EventStreamDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `EventStreamHandler` | `type` | `@kb-labs/shared-command-kit` |
| `isCLIHost` | `value` | `@kb-labs/shared-command-kit` |
| `isRESTHost` | `value` | `@kb-labs/shared-command-kit` |
| `isWebhookHost` | `value` | `@kb-labs/shared-command-kit` |
| `isWorkflowHost` | `value` | `@kb-labs/shared-command-kit` |
| `isWSHost` | `value` | `@kb-labs/shared-command-kit` |
| `MessageBuilder` | `value` | `@kb-labs/shared-command-kit` |
| `MessageRouter` | `value` | `@kb-labs/shared-command-kit` |
| `RouteDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `RouteHandler` | `type` | `@kb-labs/shared-command-kit` |
| `TypedSender` | `type` | `@kb-labs/shared-command-kit` |
| `WebhookDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `WebhookHandler` | `type` | `@kb-labs/shared-command-kit` |
| `WebSocketDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `WebSocketHandler` | `type` | `@kb-labs/shared-command-kit` |

## `@kb-labs/sdk/manifest`

Source: `src/manifest/index.ts`

Total exports: **22**

| Export | Kind | From |
|---|---|---|
| `CliGroup` | `type` | `@kb-labs/shared-command-kit` |
| `cmd` | `value` | `@kb-labs/shared-command-kit` |
| `CmdBuilder` | `type` | `@kb-labs/shared-command-kit` |
| `createManifest` | `value` | `@kb-labs/shared-command-kit` |
| `defineCommandFlags` | `value` | `./flags.js` |
| `defineManifest` | `value` | `@kb-labs/shared-command-kit` |
| `DELETE` | `value` | `@kb-labs/shared-command-kit` |
| `ExampleCase` | `type` | `(local)` |
| `generateExamples` | `value` | `(local)` |
| `GET` | `value` | `@kb-labs/shared-command-kit` |
| `group` | `value` | `@kb-labs/shared-command-kit` |
| `HandlerRef` | `type` | `@kb-labs/shared-command-kit` |
| `mergeCliGroups` | `value` | `@kb-labs/shared-command-kit` |
| `PATCH` | `value` | `@kb-labs/shared-command-kit` |
| `permissions` | `value` | `@kb-labs/shared-command-kit` |
| `PluginId` | `type` | `@kb-labs/shared-command-kit` |
| `POST` | `value` | `@kb-labs/shared-command-kit` |
| `PUT` | `value` | `@kb-labs/shared-command-kit` |
| `RestBase` | `type` | `@kb-labs/shared-command-kit` |
| `SemVer` | `type` | `@kb-labs/shared-command-kit` |
| `webhook` | `value` | `@kb-labs/shared-command-kit` |
| `WsBase` | `type` | `@kb-labs/shared-command-kit` |

## `@kb-labs/sdk/hooks`

Source: `src/hooks/index.ts`

Total exports: **28**

| Export | Kind | From |
|---|---|---|
| `AdapterMode` | `type` | `@kb-labs/core-runtime` |
| `AdapterSlotStatus` | `type` | `@kb-labs/core-runtime` |
| `getAdapterStatusFor` | `value` | `@kb-labs/core-runtime` |
| `getLLMTier` | `value` | `@kb-labs/shared-command-kit` |
| `isCacheAvailable` | `value` | `@kb-labs/shared-command-kit` |
| `isDocumentDatabaseAvailable` | `value` | `@kb-labs/shared-command-kit` |
| `isEmbeddingsAvailable` | `value` | `@kb-labs/shared-command-kit` |
| `isKVStoreAvailable` | `value` | `@kb-labs/shared-command-kit` |
| `isLLMAvailable` | `value` | `@kb-labs/shared-command-kit` |
| `isPlatformConfigured` | `value` | `@kb-labs/shared-command-kit` |
| `isVectorStoreAvailable` | `value` | `@kb-labs/shared-command-kit` |
| `LLMTier` | `type` | `@kb-labs/shared-command-kit` |
| `trackAnalyticsEvent` | `value` | `@kb-labs/shared-command-kit` |
| `useAdapterStatus` | `value` | `@kb-labs/core-runtime` |
| `useAnalytics` | `value` | `@kb-labs/shared-command-kit` |
| `useCache` | `value` | `@kb-labs/shared-command-kit` |
| `useConfig` | `value` | `@kb-labs/shared-command-kit` |
| `useDocumentDatabase` | `value` | `@kb-labs/shared-command-kit` |
| `useEmbeddings` | `value` | `@kb-labs/shared-command-kit` |
| `useEnv` | `value` | `@kb-labs/shared-command-kit` |
| `useKVStore` | `value` | `@kb-labs/shared-command-kit` |
| `useLLM` | `value` | `@kb-labs/shared-command-kit` |
| `UseLLMOptions` | `type` | `@kb-labs/shared-command-kit` |
| `useLogger` | `value` | `@kb-labs/shared-command-kit` |
| `useLoggerWithContext` | `value` | `@kb-labs/shared-command-kit` |
| `usePlatform` | `value` | `@kb-labs/shared-command-kit` |
| `useStorage` | `value` | `@kb-labs/shared-command-kit` |
| `useVectorStore` | `value` | `@kb-labs/shared-command-kit` |

## `@kb-labs/sdk/contracts`

Source: `src/contracts/index.ts`

Total exports: **48**

| Export | Kind | From |
|---|---|---|
| `ClassifiedFailure` | `type` | `@kb-labs/plugin-contracts` |
| `CleanupFn` | `type` | `@kb-labs/plugin-contracts` |
| `ColorFunction` | `type` | `@kb-labs/plugin-contracts` |
| `Colors` | `type` | `@kb-labs/plugin-contracts` |
| `CommandError` | `type` | `@kb-labs/plugin-contracts` |
| `CommandFailure` | `type` | `@kb-labs/plugin-contracts` |
| `CommandResult` | `type` | `@kb-labs/plugin-contracts` |
| `createExecutionMeta` | `value` | `@kb-labs/plugin-contracts` |
| `DEFAULT_PERMISSIONS` | `value` | `@kb-labs/plugin-contracts` |
| `ExecOptions` | `type` | `@kb-labs/plugin-contracts` |
| `ExecResult` | `type` | `@kb-labs/plugin-contracts` |
| `ExecutionTarget` | `type` | `@kb-labs/plugin-contracts` |
| `FailureClassificationContext` | `type` | `@kb-labs/plugin-contracts` |
| `FailureInfo` | `type` | `@kb-labs/plugin-contracts` |
| `FailureKind` | `type` | `@kb-labs/plugin-contracts` |
| `FailureSource` | `type` | `@kb-labs/plugin-contracts` |
| `getHandlerPath` | `value` | `@kb-labs/plugin-contracts` |
| `getHandlerPermissions` | `value` | `@kb-labs/plugin-contracts` |
| `getLoggerMetadataFromHost` | `value` | `@kb-labs/plugin-contracts` |
| `HostContext` | `type` | `@kb-labs/plugin-contracts` |
| `HostType` | `type` | `@kb-labs/plugin-contracts` |
| `isManifestV3` | `value` | `@kb-labs/plugin-contracts` |
| `ManifestV3` | `type` | `@kb-labs/plugin-contracts` |
| `noopTraceContext` | `value` | `@kb-labs/plugin-contracts` |
| `noopUI` | `value` | `@kb-labs/plugin-contracts` |
| `OutputSection` | `type` | `@kb-labs/plugin-contracts` |
| `parseManifest` | `value` | `@kb-labs/plugin-contracts` |
| `PermissionSpec` | `type` | `@kb-labs/plugin-contracts` |
| `PlatformServices` | `type` | `@kb-labs/plugin-contracts` |
| `PluginAPI` | `type` | `@kb-labs/plugin-contracts` |
| `PluginCommandContextV3` | `type` | `@kb-labs/plugin-contracts` |
| `PluginContextDescriptor` | `type` | `@kb-labs/plugin-contracts` |
| `PluginContextV3` | `type` | `@kb-labs/plugin-contracts` |
| `PluginHandlerUIFacade` | `type` | `@kb-labs/plugin-contracts` |
| `resolveHeaderPolicy` | `value` | `@kb-labs/plugin-contracts` |
| `RetryDecision` | `type` | `@kb-labs/plugin-contracts` |
| `RetryPolicyConfig` | `type` | `@kb-labs/plugin-contracts` |
| `RetrySafety` | `type` | `@kb-labs/plugin-contracts` |
| `RuntimeAPI` | `type` | `@kb-labs/plugin-contracts` |
| `ShellAPI` | `type` | `@kb-labs/plugin-contracts` |
| `SideBoxOptions` | `type` | `@kb-labs/plugin-contracts` |
| `UIFacade` | `type` | `@kb-labs/plugin-contracts` |
| `validateManifest` | `value` | `@kb-labs/plugin-contracts` |
| `WebSocketHostContext` | `type` | `@kb-labs/plugin-contracts` |
| `WSInput` | `type` | `@kb-labs/plugin-contracts` |
| `WSLifecycleEvent` | `type` | `@kb-labs/plugin-contracts` |
| `WSMessage` | `type` | `@kb-labs/plugin-contracts` |
| `WSSender` | `type` | `@kb-labs/plugin-contracts` |

## `@kb-labs/sdk/types`

Source: `src/types/index.ts`

Total exports: **52**

| Export | Kind | From |
|---|---|---|
| `*` | `type` | `../contracts/index.js` |
| `ArrayFlagSchema` | `type` | `@kb-labs/shared-command-kit` |
| `ArtifactInfo` | `type` | `@kb-labs/shared-cli-ui` |
| `BooleanFlagSchema` | `type` | `@kb-labs/shared-command-kit` |
| `DegradedLevel` | `type` | `@kb-labs/core-runtime` |
| `DegradedOptions` | `type` | `@kb-labs/core-runtime` |
| `DegradedStatus` | `type` | `@kb-labs/core-runtime` |
| `EnvDefinition` | `type` | `@kb-labs/shared-cli-ui` |
| `EnvSchema` | `type` | `@kb-labs/shared-cli-ui` |
| `ErrorDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `ErrorDefinitions` | `type` | `@kb-labs/shared-command-kit` |
| `FeedbackRecord` | `type` | `@kb-labs/core-platform` |
| `FeedbackType` | `type` | `@kb-labs/core-platform` |
| `FlagSchema` | `type` | `@kb-labs/shared-command-kit` |
| `FlagSchemaDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `FlagSchemaWithInfer` | `type` | `@kb-labs/shared-command-kit` |
| `FlagType` | `type` | `@kb-labs/shared-command-kit` |
| `FlagValidationError` | `type` | `@kb-labs/shared-command-kit` |
| `Handler` | `type` | `@kb-labs/shared-command-kit` |
| `HandlerDefinition` | `type` | `@kb-labs/shared-command-kit` |
| `HistoryFindOptions` | `type` | `@kb-labs/core-platform` |
| `HistoryRecord` | `type` | `@kb-labs/core-platform` |
| `IAnalytics` | `type` | `@kb-labs/core-platform` |
| `ICache` | `type` | `@kb-labs/core-platform` |
| `IEmbeddings` | `type` | `@kb-labs/core-platform` |
| `IFeedbackStore` | `type` | `@kb-labs/core-platform` |
| `IHistoryStore` | `type` | `@kb-labs/core-platform` |
| `ILLM` | `type` | `@kb-labs/core-platform` |
| `ILogger` | `type` | `@kb-labs/core-platform` |
| `InferFlags` | `type` | `@kb-labs/shared-command-kit` |
| `IStorage` | `type` | `@kb-labs/core-platform` |
| `IVectorStore` | `type` | `@kb-labs/core-platform` |
| `LLMMessage` | `type` | `@kb-labs/core-platform` |
| `LLMOptions` | `type` | `@kb-labs/core-platform` |
| `LLMResponse` | `type` | `@kb-labs/core-platform` |
| `LLMTool` | `type` | `@kb-labs/core-platform` |
| `LLMToolCall` | `type` | `@kb-labs/core-platform` |
| `LLMToolCallOptions` | `type` | `@kb-labs/core-platform` |
| `LLMToolCallResponse` | `type` | `@kb-labs/core-platform` |
| `Loader` | `type` | `@kb-labs/shared-cli-ui` |
| `MonitoringOptions` | `type` | `@kb-labs/core-runtime` |
| `MonitoringSnapshot` | `type` | `@kb-labs/core-runtime` |
| `NumberFlagSchema` | `type` | `@kb-labs/shared-command-kit` |
| `PermissionPreset` | `type` | `@kb-labs/perm-presets` |
| `PresetBuilder` | `type` | `@kb-labs/perm-presets` |
| `RestInput` | `type` | `@kb-labs/shared-command-kit` |
| `SafeValidationResult` | `type` | `@kb-labs/shared-command-kit` |
| `StringFlagSchema` | `type` | `@kb-labs/shared-command-kit` |
| `ToolDefinitionShape` | `type` | `@kb-labs/shared-tool-kit` |
| `ToolShape` | `type` | `@kb-labs/shared-tool-kit` |
| `ToolSpec` | `type` | `@kb-labs/shared-tool-kit` |
| `ValidationResult` | `type` | `@kb-labs/shared-command-kit` |

## `@kb-labs/sdk/testing`

Source: `src/testing/index.ts`

Total exports: **51**

| Export | Kind | From |
|---|---|---|
| `CapturedUI` | `type` | `@kb-labs/shared-testing-e2e/cli` |
| `createCapturedUI` | `value` | `@kb-labs/shared-testing-e2e/cli` |
| `createInfraApiMocks` | `value` | `@kb-labs/shared-testing-platform` |
| `createInMemoryDocumentDatabase` | `value` | `@kb-labs/shared-testing-platform` |
| `createInMemoryKVStore` | `value` | `@kb-labs/shared-testing-platform` |
| `createMockContext` | `value` | `@kb-labs/shared-testing-e2e/cli` |
| `createMockEnvironmentAPI` | `value` | `@kb-labs/shared-testing-platform` |
| `createMockPlatformApi` | `value` | `@kb-labs/shared-testing-platform` |
| `createMockPluginAPI` | `value` | `@kb-labs/shared-testing-platform` |
| `createMockPluginContextV3` | `value` | `@kb-labs/shared-testing-platform` |
| `createMockRuntime` | `value` | `@kb-labs/shared-testing-platform` |
| `createMockSnapshotAPI` | `value` | `@kb-labs/shared-testing-platform` |
| `createMockTrace` | `value` | `@kb-labs/shared-testing-platform` |
| `createMockUI` | `value` | `@kb-labs/shared-testing-platform` |
| `createMockWorkspaceAPI` | `value` | `@kb-labs/shared-testing-platform` |
| `createTestContext` | `value` | `@kb-labs/shared-testing-platform` |
| `CreateTestContextOptions` | `type` | `@kb-labs/shared-testing-platform` |
| `DocumentDatabaseContractFactory` | `type` | `@kb-labs/core-platform/adapters/contract` |
| `InMemoryDocumentDatabase` | `value` | `@kb-labs/shared-testing-platform` |
| `InMemoryDocumentDatabaseOptions` | `type` | `@kb-labs/shared-testing-platform` |
| `InMemoryKVStore` | `value` | `@kb-labs/shared-testing-platform` |
| `KVContractFactory` | `type` | `@kb-labs/core-platform/adapters/contract` |
| `LLMCall` | `type` | `@kb-labs/shared-testing` |
| `LLMToolCallRecord` | `type` | `@kb-labs/shared-testing` |
| `LogEntry` | `type` | `@kb-labs/shared-testing` |
| `mockCache` | `value` | `@kb-labs/shared-testing` |
| `MockCacheInstance` | `type` | `@kb-labs/shared-testing` |
| `mockCLIInput` | `value` | `@kb-labs/shared-testing-e2e/cli` |
| `MockCLIInputOptions` | `type` | `@kb-labs/shared-testing-e2e/cli` |
| `MockContextOptions` | `type` | `@kb-labs/shared-testing-e2e/cli` |
| `mockLLM` | `value` | `@kb-labs/shared-testing` |
| `MockLLM` | `type` | `@kb-labs/shared-testing` |
| `MockLLMInstance` | `type` | `@kb-labs/shared-testing` |
| `mockLogger` | `value` | `@kb-labs/shared-testing` |
| `MockLoggerInstance` | `type` | `@kb-labs/shared-testing` |
| `mockObject` | `value` | `@kb-labs/shared-testing-e2e/cli` |
| `mockStorage` | `value` | `@kb-labs/shared-testing` |
| `MockStorageInstance` | `type` | `@kb-labs/shared-testing` |
| `mockTool` | `value` | `@kb-labs/shared-tool-kit/testing` |
| `MockToolInstance` | `type` | `@kb-labs/shared-tool-kit/testing` |
| `runDocumentDatabaseContract` | `value` | `@kb-labs/core-platform/adapters/contract` |
| `runKVStoreContract` | `value` | `@kb-labs/core-platform/adapters/contract` |
| `setupTestPlatform` | `value` | `@kb-labs/shared-testing-platform` |
| `TestableHandler` | `type` | `@kb-labs/shared-testing-platform` |
| `testCommand` | `value` | `@kb-labs/shared-testing-platform` |
| `TestCommandOptions` | `type` | `@kb-labs/shared-testing-platform` |
| `TestCommandResult` | `type` | `@kb-labs/shared-testing-platform` |
| `TestContextResult` | `type` | `@kb-labs/shared-testing-platform` |
| `TestPlatformOptions` | `type` | `@kb-labs/shared-testing-platform` |
| `TestPlatformResult` | `type` | `@kb-labs/shared-testing-platform` |
| `UICapture` | `type` | `@kb-labs/shared-testing-e2e/cli` |

