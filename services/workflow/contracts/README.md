# @kb-labs/workflow-contracts

Contracts, types and schemas for the KB Labs workflow engine.

## Vision & Purpose

**@kb-labs/workflow-contracts** provides contracts, types, and schemas for the KB Labs workflow engine. It includes Zod validation schemas, TypeScript type definitions, and workflow specification formats.

### Core Goals

- **Zod Schemas**: Validation schemas for workflow specifications
- **TypeScript Types**: Complete type definitions for all workflow entities
- **Workflow Spec**: Type-safe workflow specification format

## Package Status

- **Version**: 0.1.0
- **Stage**: Stable
- **Status**: Production Ready ✅

## Architecture

### High-Level Overview

```
Workflow Contracts
    │
    ├──► Zod Schemas (validation)
    ├──► TypeScript Types (type safety)
    └──► Workflow Spec Format
```

### Key Components

1. **Schemas** (`schemas.ts`): Zod validation schemas
2. **Types** (`types.ts`): TypeScript type definitions

## ✨ Features

- **Zod schemas** for workflow validation
- **TypeScript types** derived from schemas
- **Workflow spec** format definition
- **Run state** types and schemas
- **Job and step** types and schemas
- **Nested workflows** support via `workflow:` uses
- **Conditional execution** with `if` expressions
- **Step outputs** and context interpolation
- **Job hooks** (pre/post/onSuccess/onFailure)

## 📦 API Reference

### Main Exports

#### Schemas

- `WorkflowSpecSchema`: Workflow specification schema
- `JobSpecSchema`: Job specification schema
- `StepSpecSchema`: Step specification schema
- `RunSchema`: Workflow run schema
- `JobRunSchema`: Job run schema
- `StepRunSchema`: Step run schema
- `RetryPolicySchema`: Retry policy schema

#### Types

- `WorkflowSpec`: Workflow specification type
- `JobSpec`: Job specification type
- `StepSpec`: Step specification type
- `WorkflowRun`: Workflow run type
- `JobRun`: Job run type
- `StepRun`: Step run type
- `RetryPolicy`: Retry policy type
- `RunTrigger`: Run trigger type
- `RunMetadata`: Run metadata type
- `IdempotencyKey`: Idempotency key type
- `ConcurrencyGroup`: Concurrency group type
- `ExecutionResult`: Execution result type

## 🔧 Configuration

### Configuration Options

No configuration needed - pure type definitions and schemas.

## 🔗 Dependencies

### Runtime Dependencies

- `@kb-labs/workflow-constants` (`workspace:*`): Workflow constants
- `zod` (`^4.1.5`): Schema validation

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

- **Time Complexity**: O(1) for type operations, O(n) for schema validation
- **Space Complexity**: O(1)
- **Bottlenecks**: Schema validation for large specs

## 🔒 Security

### Security Considerations

- **Schema Validation**: Input validation via Zod schemas
- **Type Safety**: TypeScript type safety

### Known Vulnerabilities

- None

## 🐛 Known Issues & Limitations

### Known Issues

- None currently

### Limitations

- **Schema Validation**: Basic validation only

### Future Improvements

- **Enhanced Validation**: More validation rules

## 🔄 Migration & Breaking Changes

### Migration from Previous Versions

No breaking changes in current version (0.1.0).

### Breaking Changes in Future Versions

- None planned

## 📚 Examples

### Example 1: Validate Workflow Spec

```typescript
import { WorkflowSpecSchema } from '@kb-labs/workflow-contracts';
import { z } from 'zod';

const spec = WorkflowSpecSchema.parse(yamlContent);
```

### Example 2: Type-Safe Workflow Definition

```typescript
import type { WorkflowSpec } from '@kb-labs/workflow-contracts';

const myWorkflow: WorkflowSpec = {
  name: 'my-workflow',
  version: '0.1.0',
  jobs: {
    build: {
      steps: [
        { name: 'build', uses: 'plugin:@kb-labs/build/cli' },
      ],
    },
  },
};
```

### Example 3: Nested Workflows

```yaml
name: parent-workflow
version: 1.0.0
on:
  manual: true
jobs:
  orchestration:
    runsOn: local
    steps:
      - name: Run Child Workflow
        id: child
        uses: workflow:workspace:child-workflow
        with:
          input: value
      
      - name: Use Child Output
        uses: builtin:shell
        with:
          command: echo ${{ steps.child.outputs.result }}
```

### Example 4: Conditional Execution

```yaml
name: conditional-workflow
version: 1.0.0
on:
  manual: true
jobs:
  deploy:
    runsOn: local
    if: ${{ trigger.type == 'manual' }}
    steps:
      - name: Run Tests
        id: tests
        uses: builtin:shell
        with:
          command: npm test
      
      - name: Deploy
        uses: builtin:shell
        with:
          command: npm run deploy
        if: ${{ steps.tests.outputs.exitCode == 0 }}
```

### Example 5: Job Hooks

```yaml
name: workflow-with-hooks
version: 1.0.0
on:
  manual: true
jobs:
  main:
    runsOn: local
    hooks:
      pre:
        - name: Setup
          uses: builtin:shell
          with:
            command: echo "Setting up..."
      post:
        - name: Cleanup
          uses: builtin:shell
          with:
            command: echo "Cleaning up..."
      onSuccess:
        - name: Notify Success
          uses: builtin:shell
          with:
            command: echo "✓ Success"
      onFailure:
        - name: Notify Failure
          uses: builtin:shell
          with:
            command: echo "✗ Failed"
    steps:
      - name: Main Task
        uses: builtin:shell
        with:
          command: echo "Running main task..."
```

## 🔧 Advanced Features

### Nested Workflows

Workflows can call other workflows using the `workflow:` prefix in step `uses`:

```yaml
steps:
  - name: Call Child
    uses: workflow:workspace:child-workflow
    # or
    uses: workflow:plugin:@kb-labs/plugin/workflow-id
```

**Supported modes:**
- `mode: 'wait'` (default): Wait for child workflow to complete
- `mode: 'fire-and-forget'`: Not supported in MVP (will throw error)

**Parent/Child Linkage:**
- Child runs include `parentRunId`, `parentJobId`, `parentStepId` in metadata
- Parent cancellation automatically cancels child runs
- Depth limit enforced via `maxDepth` configuration

### Conditional Execution

Steps and jobs can be conditionally executed using `if` expressions:

```yaml
steps:
  - name: Conditional Step
    if: ${{ env.NODE_ENV == 'production' }}
    uses: builtin:shell
    with:
      command: echo "Production only"
```

**Expression Context:**
- `env.*`: Environment variables
- `trigger.*`: Run trigger information
- `steps.<id>.outputs.*`: Step outputs
- `matrix.*`: Matrix variables (future)

**Supported Operators:**
- `==`, `!=`: Equality comparison
- `contains()`, `startsWith()`, `endsWith()`: String functions
- Boolean literals: `true`, `false`

### Step Outputs

Steps can produce outputs that are accessible in subsequent steps:

```yaml
steps:
  - name: Generate Version
    id: version
    uses: builtin:shell
    with:
      command: echo "1.0.0"
    # Outputs automatically captured from step execution
  
  - name: Use Output
    uses: builtin:shell
    with:
      command: echo "Version: ${{ steps.version.outputs.result }}"
```

**Output Access:**
- `steps.<id>.outputs.*`: Access step outputs in expressions
- Outputs are automatically captured from step execution results

### Job Hooks

Jobs can define hooks that run at different lifecycle stages:

- **pre**: Runs before main steps
- **post**: Runs after main steps (always)
- **onSuccess**: Runs only if job succeeds
- **onFailure**: Runs only if job fails

Hooks are executed as simplified steps (no nested hooks support in MVP).

## 🤝 Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for development guidelines.

## 📄 License

MIT © KB Labs
