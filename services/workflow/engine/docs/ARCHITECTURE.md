# Package Architecture Description: @kb-labs/workflow-engine

**Version**: 0.1.0
**Last Updated**: 2025-11-16

## Executive Summary

**@kb-labs/workflow-engine** provides workflow orchestration engine for KB Labs. It includes job scheduling, state management, Redis coordination, event bus, retry logic, concurrency control, and timeout handling.

## 1. Package Overview

### 1.1 Purpose & Scope

**Primary Purpose**: Provide workflow orchestration engine.

**Scope Boundaries**:
- **In Scope**: Job scheduling, state management, Redis coordination, event bus, retry logic, concurrency control, timeout handling, worker system
- **Out of Scope**: Workflow spec definition (in workflow-contracts), workflow execution (in workflow-runtime)

**Domain**: Workflow System / Orchestration Engine

### 1.2 Key Responsibilities

1. **Job Scheduling**: Intelligent job scheduling with dependency resolution
2. **State Management**: Distributed state management with Redis
3. **Redis Coordination**: Distributed coordination through Redis
4. **Event Bus**: Event streaming for workflow observability
5. **Retry Logic**: Configurable retry policies
6. **Concurrency Control**: Idempotency and concurrency group management
7. **Timeout Handling**: Configurable timeouts for jobs and steps
8. **Worker System**: Background processing workers

## 2. High-Level Architecture

### 2.1 Architecture Diagram

```
Workflow Engine
    │
    ├──► WorkflowEngine (engine.ts)
    │   ├──► WorkflowLoader
    │   ├──► StateStore
    │   ├──► ConcurrencyManager
    │   ├──► RunCoordinator
    │   ├──► Scheduler
    │   └──► EventBusBridge
    │
    ├──► Job Scheduling (scheduler.ts)
    │   ├──► Dependency resolution
    │   ├──► Priority-based scheduling
    │   └──► Job queue management
    │
    ├──► State Management (state-store.ts)
    │   ├──► Run state persistence
    │   ├──► Job state persistence
    │   └──► Redis-backed storage
    │
    ├──► Redis Coordination (redis.ts)
    │   ├──► Redis client management
    │   ├──► Connection pooling
    │   └──► Reconnection strategy
    │
    ├──► Event Bus (event-bus.ts)
    │   ├──► Event streaming
    │   ├──► Redis pub/sub
    │   └──► Event bridge
    │
    ├──► Retry Logic (retry.ts)
    │   ├──► Retry policies
    │   ├──► Exponential backoff
    │   └──► Max retry limits
    │
    ├──► Concurrency Control (concurrency-manager.ts)
    │   ├──► Idempotency keys
    │   ├──► Concurrency groups
    │   └──► Lock management
    │
    ├──► Job Execution (job-runner.ts, job-handler.ts)
    │   ├──► Job dispatch
    │   ├──► Step execution
    │   └──► Timeout handling
    │
    └──► Worker System (worker.ts)
        ├──► Worker lifecycle
        ├──► Job polling
        └──► Concurrent job execution
```

### 2.2 Architectural Style

- **Style**: Orchestration Engine Pattern
- **Rationale**: Central orchestration engine for workflow execution

## 3. Component Architecture

### 3.1 Component: WorkflowEngine

- **Purpose**: Main orchestration engine
- **Responsibilities**: Coordinate all components, manage workflow lifecycle
- **Dependencies**: All other components

### 3.2 Component: Scheduler

- **Purpose**: Job scheduling
- **Responsibilities**: Dependency resolution, priority-based scheduling, queue management
- **Dependencies**: Redis, state-store

### 3.3 Component: StateStore

- **Purpose**: State management
- **Responsibilities**: Persist run/job state, retrieve state
- **Dependencies**: Redis

### 3.4 Component: RunCoordinator

- **Purpose**: Run coordination
- **Responsibilities**: Coordinate run execution, manage run lifecycle
- **Dependencies**: Redis, state-store, concurrency-manager

### 3.5 Component: ConcurrencyManager

- **Purpose**: Concurrency control
- **Responsibilities**: Idempotency, concurrency groups, lock management
- **Dependencies**: Redis

### 3.6 Component: JobRunner

- **Purpose**: Job execution
- **Responsibilities**: Dispatch jobs, execute steps, handle timeouts
- **Dependencies**: workflow-runtime, plugin-runtime

### 3.7 Component: Worker

- **Purpose**: Background processing
- **Responsibilities**: Poll jobs, execute jobs, manage worker lifecycle
- **Dependencies**: WorkflowEngine, JobRunner

### 3.8 Component: EventBus

- **Purpose**: Event streaming
- **Responsibilities**: Emit events, subscribe to events, bridge events
- **Dependencies**: Redis

## 4. Data Flow

```
engine.run(spec, options)
    │
    ├──► Load workflow spec
    ├──► Acquire concurrency lock
    ├──► Create run in state store
    ├──► Schedule jobs
    ├──► Emit run.started event
    └──► return run

worker.start()
    │
    ├──► Poll for jobs
    ├──► Acquire job lease
    ├──► Execute job (via JobRunner)
    ├──► Update job state
    ├──► Emit job events
    └──► Release job lease
```

## 5. Design Patterns

- **Orchestration Engine Pattern**: Central orchestration engine
- **State Machine Pattern**: Workflow state management
- **Pub/Sub Pattern**: Event bus with Redis pub/sub
- **Worker Pattern**: Background processing workers
- **Retry Pattern**: Retry logic with exponential backoff

## 6. Performance Architecture

- **Time Complexity**: O(n) for scheduling, O(1) for state operations
- **Space Complexity**: O(n) where n = number of jobs
- **Bottlenecks**: Redis operations, job scheduling

## 7. Security Architecture

- **Redis Security**: Redis connection security
- **Permission Checking**: Capability checks before execution
- **Secrets Management**: Secrets management for workflows
- **Concurrency Control**: Idempotency and concurrency limits

---

**Last Updated**: 2025-11-16

