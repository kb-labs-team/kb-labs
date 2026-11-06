# Package Architecture Description: @kb-labs/workflow-constants

**Version**: 0.1.0
**Last Updated**: 2025-11-16

## Executive Summary

**@kb-labs/workflow-constants** provides shared constants for the KB Labs workflow engine. It includes state constants, event names, status enums, and Redis key factories.

## 1. Package Overview

### 1.1 Purpose & Scope

**Primary Purpose**: Provide shared constants for workflow engine.

**Scope Boundaries**:
- **In Scope**: Constants, types, Redis key factory
- **Out of Scope**: Workflow execution, workflow runtime

**Domain**: Workflow System / Constants

### 1.2 Key Responsibilities

1. **State Constants**: Workflow, job, and step state definitions
2. **Event Names**: Event type constants for workflow events
3. **Redis Key Factory**: Redis key generation utilities

## 2. High-Level Architecture

### 2.1 Architecture Diagram

```
Workflow Constants
    │
    ├──► State Constants
    │   ├──► RUN_STATES
    │   ├──► JOB_STATES
    │   └──► STEP_STATES
    │
    ├──► Event Names
    │   ├──► run events
    │   ├──► job events
    │   └──► step events
    │
    ├──► Priority Constants
    │   └──► JOB_PRIORITIES
    │
    └──► Redis Key Factory
        ├──► Key generation
        └──► Namespace management
```

### 2.2 Architectural Style

- **Style**: Constants Package Pattern
- **Rationale**: Centralized constants for workflow system

## 3. Component Architecture

### 3.1 Component: Constants

- **Purpose**: Define constants
- **Responsibilities**: State constants, event names, priorities
- **Dependencies**: None

### 3.2 Component: Redis Key Factory

- **Purpose**: Generate Redis keys
- **Responsibilities**: Key generation, namespace management
- **Dependencies**: None

## 4. Data Flow

```
createRedisKeyFactory(options)
    │
    ├──► Normalize namespace
    ├──► Create factory functions
    └──► return factory
```

## 5. Design Patterns

- **Constants Package Pattern**: Centralized constants
- **Factory Pattern**: Redis key factory

## 6. Performance Architecture

- **Time Complexity**: O(1) for all operations
- **Space Complexity**: O(1)
- **Bottlenecks**: None

## 7. Security Architecture

- **Key Factory**: Secure key generation
- **Namespace Validation**: Namespace validation

---

**Last Updated**: 2025-11-16

