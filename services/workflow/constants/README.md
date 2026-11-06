# @kb-labs/workflow-constants

Shared constants for the KB Labs workflow engine.

## Vision & Purpose

**@kb-labs/workflow-constants** provides shared constants for the KB Labs workflow engine. It includes state constants, event names, status enums, and Redis key factories.

### Core Goals

- **State Constants**: Workflow, job, and step state definitions
- **Event Names**: Event type constants for workflow events
- **Status Enums**: Status and state enumerations
- **Redis Key Factory**: Redis key generation utilities

## Package Status

- **Version**: 0.1.0
- **Stage**: Stable
- **Status**: Production Ready ✅

## Architecture

### High-Level Overview

```
Workflow Constants
    │
    ├──► State Constants
    ├──► Event Names
    ├──► Priority Constants
    └──► Redis Key Factory
```

### Key Components

1. **Constants** (`index.ts`): All constants and utilities

## ✨ Features

- **State constants** for workflow, job, and step states
- **Event names** for workflow events
- **Priority constants** for job priorities
- **Redis key factory** for key generation
- **Environment variable constants** for configuration

## 📦 API Reference

### Main Exports

#### Constants

- `RUN_STATES`: Workflow run states
- `JOB_STATES`: Job execution states
- `STEP_STATES`: Step execution states
- `JOB_PRIORITIES`: Job priority levels
- `EVENT_NAMES`: Event type names

#### Types

- `RunState`: Run state type
- `JobState`: Job state type
- `StepState`: Step state type
- `JobPriority`: Job priority type
- `WorkflowEventName`: Workflow event name type
- `RedisMode`: Redis mode type

#### Functions

- `createRedisKeyFactory(options)`: Create Redis key factory

#### Constants

- `DEFAULT_REDIS_NAMESPACE`: Default Redis namespace
- `WORKFLOW_REDIS_CHANNEL`: Workflow Redis channel
- `IDEMPOTENCY_TTL_ENV`: Idempotency TTL environment variable
- `CONCURRENCY_TTL_ENV`: Concurrency TTL environment variable
- `REDIS_URL_ENV`: Redis URL environment variable
- `REDIS_MODE_ENV`: Redis mode environment variable
- `REDIS_NAMESPACE_ENV`: Redis namespace environment variable

## 🔧 Configuration

### Configuration Options

#### RedisKeyFactoryOptions

- **namespace**: Redis namespace (default: `'kb'`)

### Environment Variables

- `KB_WF_IDEMP_TTL_MS`: Idempotency TTL in milliseconds
- `KB_WF_CONC_TTL_MS`: Concurrency TTL in milliseconds
- `KB_REDIS_URL`: Redis connection URL
- `KB_REDIS_MODE`: Redis mode (standalone/cluster/sentinel)
- `KB_REDIS_NAMESPACE`: Redis namespace

## 🔗 Dependencies

### Runtime Dependencies

None (pure constants package)

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

- **Time Complexity**: O(1) for all operations
- **Space Complexity**: O(1)
- **Bottlenecks**: None

## 🔒 Security

### Security Considerations

- **Key Factory**: Secure key generation
- **Namespace Validation**: Namespace validation

### Known Vulnerabilities

- None

## 🐛 Known Issues & Limitations

### Known Issues

- None currently

### Limitations

- **Fixed Constants**: Constants are fixed (no dynamic configuration)

### Future Improvements

- **Dynamic Constants**: Configurable constants support

## 🔄 Migration & Breaking Changes

### Migration from Previous Versions

No breaking changes in current version (0.1.0).

### Breaking Changes in Future Versions

- None planned

## 📚 Examples

### Example 1: Use State Constants

```typescript
import { RUN_STATES, StepState } from '@kb-labs/workflow-constants';

if (run.state === RUN_STATES.RUNNING) {
  // ...
}

const stepState: StepState = StepState.SUCCESS;
```

### Example 2: Use Event Names

```typescript
import { EVENT_NAMES } from '@kb-labs/workflow-constants';

eventBus.publish(EVENT_NAMES.run.started, data);
```

### Example 3: Create Redis Key Factory

```typescript
import { createRedisKeyFactory } from '@kb-labs/workflow-constants';

const keys = createRedisKeyFactory({ namespace: 'kb' });
const runKey = keys.run('run-123');
const queueKey = keys.jobQueue('high');
```

## 🤝 Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for development guidelines.

## 📄 License

MIT © KB Labs
