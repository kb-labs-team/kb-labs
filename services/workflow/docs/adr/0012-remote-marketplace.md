# ADR-0012: Remote Workflow Marketplace

**Date:** 2025-11-17
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2025-11-17
**Tags:** [workflow, registry, discovery]

## Context

Workflows should be shareable and reusable across teams and projects. Without a marketplace mechanism:
- Teams duplicate workflow definitions
- Best practices aren't shared
- Updates require manual copying
- No centralized workflow library

Users need a way to:
- Discover workflows from external sources (Git repositories)
- Use workflows without copying files locally
- Update workflows from their source
- Maintain workflow versioning

## Decision

We implemented a remote workflow registry that discovers workflows from Git repositories and integrates them into the workflow discovery system.

### Architecture

1. **Configuration**: Extended `WorkflowConfigSchema` with `remotes` array:
   ```typescript
   remotes: [
     {
       name: string,
       url: string,
       ref?: string,  // branch, tag, or commit
       path?: string  // subdirectory in repo
     }
   ]
   ```

2. **Remote Registry**: Created `RemoteWorkflowRegistry` that:
   - Clones/fetches Git repositories to local cache
   - Discovers workflow files (YAML/JSON) in repository
   - Validates workflows against `WorkflowSpecSchema`
   - Generates workflow IDs with `remote:` prefix
   - Caches workflows for performance

3. **Composite Integration**: `CompositeWorkflowRegistry` combines:
   - Workspace workflows (`workspace:*`)
   - Plugin workflows (`plugin:*`)
   - Remote workflows (`remote:*`)

4. **CLI Commands**: Added marketplace management commands:
   - `kb wf marketplace:add` - Add remote source
   - `kb wf marketplace:list` - List configured sources
   - `kb wf marketplace:remove` - Remove source
   - `kb wf marketplace:update` - Refresh remote workflows

### Implementation Details

**Repository Caching:**
- Local cache: `.kb/workflows/cache/remotes/{name}/`
- Git operations: `git clone`, `git fetch`, `git checkout`
- Cache invalidation: Manual via `marketplace:update` command

**Workflow Discovery:**
- Scans repository for `.yml`, `.yaml`, `.json` files
- Validates against `WorkflowSpecSchema`
- Generates IDs: `remote:{name}:{filename}`

**Configuration Management:**
- Uses `saveWorkflowConfig()` for safe config updates
- Preserves other `kb.config.json` sections
- Deep merges arrays (remotes)

**Error Handling:**
- Git clone failures: Logged, registry continues with other sources
- Invalid workflows: Skipped with warning
- Network failures: Cached workflows used, refresh fails gracefully

## Consequences

### Positive

- **Workflow Sharing**: Easy sharing across teams/projects
- **Centralized Library**: Single source of truth for workflows
- **Version Control**: Git-based versioning and updates
- **No Local Copies**: Workflows stay in source repository
- **Flexible Sources**: Support any Git repository

### Negative

- **Git Dependency**: Requires Git for repository operations
- **Network Dependency**: Initial clone requires network access
- **Cache Management**: Local cache can grow large
- **Update Complexity**: Manual refresh required (no auto-update in MVP)
- **Security Concerns**: Remote workflows execute in same context (future: sandboxing)

### Alternatives Considered

- **NPM Package Distribution**: Rejected - Git is more flexible, no build step
- **Centralized Registry Service**: Rejected - adds infrastructure, Git is simpler
- **Local Copy Only**: Rejected - doesn't solve sharing/updates
- **HTTP API Registry**: Rejected - Git provides versioning and access control

## Implementation

### Changes Made

1. **Runtime** (`@kb-labs/workflow-runtime`):
   - Created `RemoteWorkflowRegistry` class
   - Extended `WorkflowConfigSchema` with `remotes`
   - Added `saveWorkflowConfig()` utility
   - Integrated into `CompositeWorkflowRegistry`

2. **CLI** (`@kb-labs/cli-commands`):
   - Added `kb wf marketplace:*` commands
   - Registered in workflow command group

### Example Usage

```bash
# Add remote marketplace
kb wf marketplace:add \
  --name shared-workflows \
  --url https://github.com/org/workflows.git \
  --ref main \
  --path workflows/

# List marketplaces
kb wf marketplace:list

# Update remote workflows
kb wf marketplace:update shared-workflows

# Remove marketplace
kb wf marketplace:remove shared-workflows
```

### Configuration

```json
{
  "workflow": {
    "remotes": [
      {
        "name": "shared-workflows",
        "url": "https://github.com/org/workflows.git",
        "ref": "main",
        "path": "workflows/"
      }
    ]
  }
}
```

### Future Enhancements

- Automatic cache refresh
- Workflow versioning and pinning
- Security sandboxing for remote workflows
- Workflow signing and verification
- Marketplace UI/web interface
- Workflow ratings and reviews

## References

- [Workflow Engine README](../../packages/workflow-engine/README.md)
- [CLI Workflows Documentation](../../../kb-labs-cli/packages/commands/docs/workflows.md#remote-marketplace)

---

**Last Updated:** 2025-11-17  
**Next Review:** 2026-05-17

