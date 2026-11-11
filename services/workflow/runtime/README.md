# @kb-labs/workflow-runtime

Runtime adapters and step executors for the KB Labs workflow engine.

## Vision & Purpose

**@kb-labs/workflow-runtime** provides runtime adapters and step executors for workflow execution. It includes local runner for in-process execution, sandbox runner for plugin commands, context management, and signal handling.

### Core Goals

- **Local Runner**: Execute steps in-process
- **Sandbox Runner**: Execute plugin commands in sandboxed environment
- **Context Management**: Step execution context with environment and secrets
- **Signal Handling**: Proper cancellation and timeout handling

## Package Status

- **Version**: 0.1.0
- **Stage**: Stable
- **Status**: Production Ready ✅

## Architecture

### High-Level Overview

```
Workflow Runtime
    │
    ├──► Local Runner (in-process execution)
    ├──► Sandbox Runner (plugin commands)
    ├──► Context Management
    └──► Signal Handling
```

### Key Components

1. **LocalRunner** (`runners/local-runner.ts`): Execute steps in-process
2. **SandboxRunner** (`runners/sandbox-runner.ts`): Execute plugin commands in sandbox
3. **Context** (`context.ts`): Step execution context creation
4. **Types** (`types.ts`): Type definitions

## ✨ Features

- **Local execution** for shell commands
- **Sandbox execution** for plugin commands
- **Context management** with environment and secrets
- **Signal handling** for cancellation and timeouts
- **Artifact support** for step outputs
- **Event emission** for step observability
- **Tracing support** for distributed tracing

## 📦 API Reference

### Main Exports

#### Runner Classes

- `LocalRunner`: Execute steps in-process
- `SandboxRunner`: Execute plugin commands in sandbox

#### Context Functions

- `createStepContext(input)`: Create step execution context

#### Types & Interfaces

- `Runner`: Runner interface
- `StepContext`: Step execution context
- `StepExecutionRequest`: Step execution request
- `StepExecutionResult`: Step execution result

### Types & Interfaces

#### `Runner`

```typescript
interface Runner {
  execute(request: StepExecutionRequest): Promise<StepExecutionResult>;
}
```

#### `StepContext`

```typescript
interface StepContext {
  runId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  env: Record<string, string>;
  secrets: Record<string, string>;
  artifacts?: ArtifactClient;
  events?: RuntimeEvents;
  logger: RuntimeLogger;
  trace?: RuntimeTrace;
  pluginContext?: PluginContext;
}
```

#### `StepExecutionRequest`

```typescript
interface StepExecutionRequest {
  spec: StepSpec;
  context: StepContext;
  workspace?: string;
  signal?: AbortSignal;
}
```

#### `StepExecutionResult`

```typescript
type StepExecutionResult = 
  | StepExecutionSuccess 
  | StepExecutionFailure;

interface StepExecutionSuccess {
  status: 'success';
  outputs?: Record<string, unknown>;
}

interface StepExecutionFailure {
  status: 'failed' | 'cancelled';
  error: {
    message: string;
    code?: string;
    stack?: string;
    details?: Record<string, unknown>;
  };
}
```

## 🔧 Configuration

### Configuration Options

#### LocalRunner Options

- **shell**: Shell to use (default: `process.env.SHELL` or `'bash'`)

#### SandboxRunner Options

- **timeoutMs**: Timeout in milliseconds
- **resolveCommand**: Command resolver function

### Environment Variables

- `SHELL`: Shell to use for local runner
- `LOG_LEVEL`: Logging level

## 🔗 Dependencies

### Runtime Dependencies

- `@kb-labs/workflow-artifacts` (`workspace:*`): Workflow artifacts
- `@kb-labs/workflow-constants` (`workspace:*`): Workflow constants
- `@kb-labs/workflow-contracts` (`workspace:*`): Workflow contracts
- `@kb-labs/plugin-manifest` (`link:../../../kb-labs-plugin/packages/manifest`): Plugin manifest
- `@kb-labs/plugin-runtime` (`link:../../../kb-labs-plugin/packages/runtime`): Plugin runtime
- `execa` (`^9.4.0`): Process execution
- `pino` (`^9.4.0`): Logger
- `pathe` (`^1.1.1`): Path utilities

### Development Dependencies

- `@kb-labs/devkit` (`link:../../../kb-labs-devkit`): DevKit presets
- `@types/node` (`^24.3.3`): Node.js types
- `tsup` (`^8.5.0`): TypeScript bundler
- `typescript` (`^5.6.3`): TypeScript compiler
- `vitest` (`^4.1.11`): Test runner

## 🧪 Testing

### Test Structure

```
src/__tests__/
└── (tests to be added)
```

### Test Coverage

- **Current Coverage**: ~0% (tests to be added)
- **Target Coverage**: 90%

## 📈 Performance

### Performance Characteristics

- **Time Complexity**: O(1) for execution setup, O(n) for step execution
- **Space Complexity**: O(1)
- **Bottlenecks**: Step execution time

## 🔒 Security

### Security Considerations

- **Sandbox Execution**: Plugin commands execute in sandbox
- **Permission Checking**: Capability checks before execution
- **Secrets Management**: Secrets passed via context
- **Signal Handling**: Proper cancellation handling

### Known Vulnerabilities

- None

## 🐛 Known Issues & Limitations

### Known Issues

- None currently

### Limitations

- **Local Runner**: Only supports shell commands
- **Sandbox Runner**: Requires command resolver configuration

### Future Improvements

- **More Runner Types**: Additional runner types
- **Enhanced Context**: More context features

## 🔄 Migration & Breaking Changes

### Migration from Previous Versions

No breaking changes in current version (0.1.0).

### Breaking Changes in Future Versions

- None planned

## 📚 Examples

### Example 1: Local Runner

```typescript
import { LocalRunner } from '@kb-labs/workflow-runtime';
import { createStepContext } from '@kb-labs/workflow-runtime';

const runner = new LocalRunner({ shell: 'bash' });

const context = createStepContext({
  runId: 'run-123',
  jobId: 'job-abc',
  stepId: 'step-xyz',
  env: { NODE_ENV: 'production' },
});

const result = await runner.execute({
  spec: {
    name: 'build',
    uses: 'builtin:shell',
    with: { command: 'npm run build' },
  },
  context,
});
```

### Example 2: Sandbox Runner

```typescript
import { SandboxRunner } from '@kb-labs/workflow-runtime';

const runner = new SandboxRunner({
  timeoutMs: 30000,
  resolveCommand: async (commandRef, request) => {
    // Resolve plugin command
    return {
      manifest,
      handler,
      permissions,
      pluginRoot,
    };
  },
});

const result = await runner.execute({
  spec: {
    name: 'review',
    uses: 'plugin:ai-review:review',
    with: { input: '...' },
  },
  context,
});
```

### Example 3: Context with Artifacts

```typescript
import { createStepContext } from '@kb-labs/workflow-runtime';
import { createFileSystemArtifactClient } from '@kb-labs/workflow-artifacts';

const artifacts = createFileSystemArtifactClient({
  baseDir: '/tmp/artifacts',
});

const context = createStepContext({
  runId: 'run-123',
  jobId: 'job-abc',
  stepId: 'step-xyz',
  artifacts,
});
```

## 🤝 Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for development guidelines.

## 📄 License

MIT © KB Labs
