# @kb-labs/workflow-artifacts

Artifact helpers for KB Labs workflow engine.

## Vision & Purpose

**@kb-labs/workflow-artifacts** provides artifact helpers for the KB Labs workflow engine. It includes file system client for reading and writing workflow artifacts, artifact management, and path organization.

### Core Goals

- **File System Client**: Operations for reading and writing workflow artifacts
- **Artifact Management**: Helpers for artifact paths and organization
- **Stream Support**: Support for streaming artifacts

## Package Status

- **Version**: 0.1.0
- **Stage**: Stable
- **Status**: Production Ready ✅

## Architecture

### High-Level Overview

```
Workflow Artifacts
    │
    ├──► File System Client
    ├──► Artifact Types
    └──► Path Management
```

### Key Components

1. **FileSystemArtifactClient** (`fs-client.ts`): File system-based artifact client
2. **Types** (`types.ts`): Artifact type definitions

## ✨ Features

- **File system client** for artifacts
- **Read/write operations** for artifacts
- **Stream support** for large artifacts
- **Path validation** and security
- **List operations** for artifact discovery

## 📦 API Reference

### Main Exports

#### Client Classes

- `FileSystemArtifactClient`: File system-based artifact client
- `createFileSystemArtifactClient(options)`: Factory function

#### Types & Interfaces

- `ArtifactClient`: Artifact client interface
- `ArtifactInput`: Artifact input types
- `ArtifactOutput`: Artifact output type
- `ArtifactReference`: Artifact reference type

### Types & Interfaces

#### `ArtifactClient`

```typescript
interface ArtifactClient {
  produce(path: string, input: ArtifactInput): Promise<void>;
  consume(path: string): Promise<ArtifactOutput>;
  list?(prefix?: string): Promise<ArtifactReference[]>;
  basePath?: () => string;
}
```

#### `ArtifactInput`

```typescript
type ArtifactInput =
  | string
  | Buffer
  | Uint8Array
  | NodeJS.ReadableStream;
```

#### `ArtifactReference`

```typescript
interface ArtifactReference {
  path: string;
  size?: number;
  contentType?: string;
  modifiedAt?: Date;
}
```

## 🔧 Configuration

### Configuration Options

#### FileSystemArtifactClientOptions

- **root**: Root directory for artifacts (required)
- **defaultContentType**: Default content type

## 🔗 Dependencies

### Runtime Dependencies

- `pathe` (`^1.1.2`): Path utilities

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

- **Time Complexity**: O(1) for operations, O(n) for listing
- **Space Complexity**: O(1)
- **Bottlenecks**: File I/O operations

## 🔒 Security

### Security Considerations

- **Path Validation**: Path escaping prevention
- **Root Directory**: Artifacts restricted to root directory

### Known Vulnerabilities

- None

## 🐛 Known Issues & Limitations

### Known Issues

- None currently

### Limitations

- **File System Only**: Only file system implementation
- **No Remote Storage**: No S3/remote storage support

### Future Improvements

- **Remote Storage**: S3/remote storage support
- **Compression**: Artifact compression support

## 🔄 Migration & Breaking Changes

### Migration from Previous Versions

No breaking changes in current version (0.1.0).

### Breaking Changes in Future Versions

- None planned

## 📚 Examples

### Example 1: Create Artifact Client

```typescript
import { createFileSystemArtifactClient } from '@kb-labs/workflow-artifacts';

const client = createFileSystemArtifactClient({
  root: '/path/to/artifacts',
});
```

### Example 2: Read Artifact

```typescript
const content = await client.consume('run-123/job-abc/artifact.txt');
```

### Example 3: Write Artifact

```typescript
await client.produce('run-123/job-abc/artifact.txt', 'content');
```

### Example 4: List Artifacts

```typescript
const artifacts = await client.list('run-123/');
```

## 🤝 Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for development guidelines.

## 📄 License

MIT © KB Labs
