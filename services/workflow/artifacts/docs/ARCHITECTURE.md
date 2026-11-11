# Package Architecture Description: @kb-labs/workflow-artifacts

**Version**: 0.1.0
**Last Updated**: 2025-11-16

## Executive Summary

**@kb-labs/workflow-artifacts** provides artifact helpers for the KB Labs workflow engine. It includes file system client for reading and writing workflow artifacts, artifact management, and path organization.

## 1. Package Overview

### 1.1 Purpose & Scope

**Primary Purpose**: Provide artifact helpers for workflow engine.

**Scope Boundaries**:
- **In Scope**: File system client, artifact types, path management
- **Out of Scope**: Remote storage (S3), artifact compression

**Domain**: Workflow System / Artifacts

### 1.2 Key Responsibilities

1. **File System Client**: File system-based artifact operations
2. **Artifact Management**: Artifact path and organization
3. **Stream Support**: Support for streaming artifacts

## 2. High-Level Architecture

### 2.1 Architecture Diagram

```
Workflow Artifacts
    │
    ├──► File System Client (fs-client.ts)
    │   ├──► Read operations
    │   ├──► Write operations
    │   ├──► List operations
    │   └──► Path validation
    │
    └──► Types (types.ts)
        ├──► ArtifactClient interface
        ├──► ArtifactInput types
        └──► ArtifactReference type
```

### 2.2 Architectural Style

- **Style**: Adapter Pattern
- **Rationale**: Adapt file system to artifact client interface

## 3. Component Architecture

### 3.1 Component: FileSystemArtifactClient

- **Purpose**: File system-based artifact client
- **Responsibilities**: Read/write artifacts, list artifacts, path validation
- **Dependencies**: pathe, node:fs

### 3.2 Component: Types

- **Purpose**: Type definitions
- **Responsibilities**: Define artifact types and interfaces
- **Dependencies**: None

## 4. Data Flow

```
client.produce(path, input)
    │
    ├──► Validate path
    ├──► Create parent directory
    ├──► Write artifact (string/Buffer/stream)
    └──► return

client.consume(path)
    │
    ├──► Validate path
    ├──► Read artifact
    └──► return Buffer

client.list(prefix)
    │
    ├──► Walk directory tree
    ├──► Collect artifacts
    └──► return ArtifactReference[]
```

## 5. Design Patterns

- **Adapter Pattern**: File system adapter for artifacts
- **Factory Pattern**: Client creation

## 6. Performance Architecture

- **Time Complexity**: O(1) for operations, O(n) for listing
- **Space Complexity**: O(1)
- **Bottlenecks**: File I/O operations

## 7. Security Architecture

- **Path Validation**: Path escaping prevention
- **Root Directory**: Artifacts restricted to root directory

---

**Last Updated**: 2025-11-16

