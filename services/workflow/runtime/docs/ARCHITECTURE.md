# Package Architecture Description: @kb-labs/workflow-runtime

**Version**: 0.1.0
**Last Updated**: 2025-11-16

## Executive Summary

**@kb-labs/workflow-runtime** provides runtime adapters and step executors for workflow execution. It includes local runner for in-process execution, sandbox runner for plugin commands, context management, and signal handling.

## 1. Package Overview

### 1.1 Purpose & Scope

**Primary Purpose**: Provide runtime adapters and step executors for workflow execution.

**Scope Boundaries**:
- **In Scope**: Step execution, context management, signal handling
- **Out of Scope**: Workflow orchestration (in workflow-engine), workflow spec definition (in workflow-contracts)

**Domain**: Workflow System / Runtime Adapters

### 1.2 Key Responsibilities

1. **Local Execution**: Execute steps in-process
2. **Sandbox Execution**: Execute plugin commands in sandbox
3. **Context Management**: Manage step execution context
4. **Signal Handling**: Handle cancellation and timeouts

## 2. High-Level Architecture

### 2.1 Architecture Diagram

```
Workflow Runtime
    │
    ├──► Local Runner (runners/local-runner.ts)
    │   ├──► Shell command execution
    │   ├──► Environment setup
    │   └──► Signal handling
    │
    ├──► Sandbox Runner (runners/sandbox-runner.ts)
    │   ├──► Plugin command resolution
    │   ├──► Sandbox execution
    │   └──► Permission checking
    │
    ├──► Context Management (context.ts)
    │   ├──► Context creation
    │   ├──► Environment merging
    │   └──► Logger setup
    │
    └──► Types (types.ts)
        ├──► Runner interface
        ├──► Step context
        └──► Execution results
```

### 2.2 Architectural Style

- **Style**: Adapter Pattern
- **Rationale**: Adapt different execution strategies to unified interface

## 3. Component Architecture

### 3.1 Component: LocalRunner

- **Purpose**: Execute steps in-process
- **Responsibilities**: Shell command execution, environment setup, signal handling
- **Dependencies**: execa, workflow-contracts

### 3.2 Component: SandboxRunner

- **Purpose**: Execute plugin commands in sandbox
- **Responsibilities**: Command resolution, sandbox execution, permission checking
- **Dependencies**: plugin-runtime, plugin-manifest

### 3.3 Component: Context Management

- **Purpose**: Manage step execution context
- **Responsibilities**: Context creation, environment merging, logger setup
- **Dependencies**: pino, workflow-artifacts

## 4. Data Flow

```
runner.execute(request)
    │
    ├──► Validate step spec
    ├──► Setup context
    ├──► Execute step (local or sandbox)
    ├──► Handle signals
    ├──► Collect outputs
    └──► return result

createStepContext(input)
    │
    ├──► Merge environment
    ├──► Setup logger
    ├──► Setup artifacts
    └──► return context
```

## 5. Design Patterns

- **Adapter Pattern**: Runtime adapters for different execution strategies
- **Strategy Pattern**: Different runners (local, sandbox)
- **Factory Pattern**: Context creation

## 6. Performance Architecture

- **Time Complexity**: O(1) for execution setup, O(n) for step execution
- **Space Complexity**: O(1)
- **Bottlenecks**: Step execution time

## 7. Security Architecture

- **Sandbox Execution**: Plugin commands execute in sandbox
- **Permission Checking**: Capability checks before execution
- **Secrets Management**: Secrets passed via context
- **Signal Handling**: Proper cancellation handling

---

**Last Updated**: 2025-11-16

