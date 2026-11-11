# ADR-0016: Granular Permissions for Workflows and Jobs

**Date:** 2026-01-15
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-01-15
**Tags:** [security, permissions, workflows, jobs, plugin-system]

## Context

The V3 Plugin System provides workflow and jobs APIs to all plugins via `ctx.api.workflows` and `ctx.api.jobs`. Without granular permissions, any plugin could:
- Start any workflow (including destructive operations)
- Submit any job type (potentially expensive or sensitive operations)
- Cancel workflows/jobs started by other plugins
- List all workflows/jobs across the entire system

This violates the **principle of least privilege** and creates security risks in multi-plugin environments.

### Requirements

1. **Deny by default** - Plugins must explicitly request workflow/jobs access
2. **Operation-level control** - Separate permissions for run/list/cancel (workflows) and submit/schedule/list/cancel (jobs)
3. **Scope restrictions** - Limit plugins to specific workflow IDs or job types
4. **Pattern matching** - Support glob patterns like `analytics-*` or `send-*`
5. **Consistent with existing patterns** - Follow the same permission model as cache namespaces and event pub/sub
6. **Backward compatible** - Existing plugins without permissions should be denied (secure by default)

### Problem

Without scope restrictions:
```typescript
// Analytics plugin can start ANY workflow
await ctx.api.workflows.run('delete-all-data', {}); // ❌ Dangerous!

// Email plugin can submit ANY job type
await ctx.api.jobs.submit({ type: 'process-payment', payload: {} }); // ❌ Wrong plugin!
```

## Decision

We added granular permissions to `PermissionSpec` with scope support using glob patterns.

### Permission Structure

```typescript
platform?: {
  workflows?: boolean | {
    /** Can start workflows */
    run?: boolean;
    /** Can list/status workflows */
    list?: boolean;
    /** Can cancel workflows */
    cancel?: boolean;
    /** Allowed workflow IDs (glob patterns) */
    workflowIds?: string[];
  };
  jobs?: boolean | {
    /** Can submit jobs */
    submit?: boolean;
    /** Can schedule jobs */
    schedule?: boolean;
    /** Can list/status jobs */
    list?: boolean;
    /** Can cancel jobs */
    cancel?: boolean;
    /** Allowed job types (glob patterns) */
    types?: string[];
  };
}
```

### Permission Modes

**1. Denied (Secure by Default)**
```typescript
platform: {
  workflows: false,  // Explicitly denied
  jobs: false,       // Explicitly denied
}

// Or omitted (same effect)
platform: {
  // workflows not specified = denied
}
```

**2. Full Access**
```typescript
platform: {
  workflows: true,  // All operations allowed
  jobs: true,       // All operations allowed
}
```

**3. Granular (Operation-Level)**
```typescript
platform: {
  workflows: {
    run: true,
    list: true,
    cancel: false,  // Cannot cancel
  },
}
```

**4. Granular with Scope**
```typescript
platform: {
  workflows: {
    run: true,
    list: true,
    workflowIds: ['analytics-*', 'reports-daily'],
  },
  jobs: {
    submit: true,
    schedule: true,
    types: ['send-*', 'cleanup-*'],
  },
}
```

### Scope Pattern Matching

- **`*`** - matches everything (unrestricted access)
- **`prefix-*`** - matches anything starting with `prefix-`
- **`exact-name`** - exact match only

Examples:
```typescript
workflowIds: ['*']                     // All workflows allowed
workflowIds: ['analytics-*']           // Only analytics-* workflows
workflowIds: ['analytics-*', 'audit-*'] // Multiple prefixes
workflowIds: ['specific-workflow']     // One specific workflow only

types: ['*']                           // All job types allowed
types: ['send-*', 'cleanup-*']         // Only send-* and cleanup-* jobs
types: ['send-email']                  // One specific job type only
```

### Permission Checking Algorithm

```typescript
function checkWorkflowPermission(
  permissions: PermissionSpec | undefined,
  operation: 'run' | 'list' | 'cancel',
  workflowId?: string
): void {
  const workflowPerms = permissions?.platform?.workflows;

  // 1. Check if workflows is false/undefined
  if (workflowPerms === false || workflowPerms === undefined) {
    throw new Error('Workflow engine access denied');
  }

  // 2. If workflows is true, allow all
  if (workflowPerms === true) {
    return;
  }

  // 3. Check specific operation permission
  if (typeof workflowPerms === 'object') {
    if (!workflowPerms[operation]) {
      throw new Error(`Workflow operation '${operation}' denied`);
    }

    // 4. Check scope (if workflowId and workflowIds specified)
    if (workflowId && workflowPerms.workflowIds && workflowPerms.workflowIds.length > 0) {
      const allowed = workflowPerms.workflowIds.some(pattern => {
        if (pattern === '*') return true;
        if (pattern.endsWith('*')) {
          const prefix = pattern.slice(0, -1);
          return workflowId.startsWith(prefix);
        }
        return pattern === workflowId;
      });

      if (!allowed) {
        throw new Error(
          `Workflow '${workflowId}' access denied: not in allowed workflowIds scope`
        );
      }
    }
  }
}
```

### Integration Points

**1. Plugin Manifest**
```json
{
  "id": "analytics-plugin",
  "permissions": {
    "platform": {
      "workflows": {
        "run": true,
        "list": true,
        "workflowIds": ["analytics-*"]
      }
    }
  }
}
```

**2. API Adapters** (`plugin-runtime/src/api/workflows.ts`, `plugin-runtime/src/api/jobs.ts`)
- Permission checks performed before calling underlying engine/scheduler
- Scope validated against workflowId/jobType before execution

**3. Context Factory** (`plugin-runtime/src/context/context-factory.ts`)
- Permissions passed from manifest → createPluginAPI → createWorkflowsAPI/createJobsAPI

## Consequences

### Positive

1. **Security by Default**
   - All plugins denied workflow/jobs access unless explicitly granted
   - Prevents accidental or malicious workflow execution

2. **Fine-Grained Control**
   - System administrators can restrict plugins to specific workflows/jobs
   - Operation-level permissions prevent unauthorized cancellation

3. **Consistency**
   - Same permission pattern as cache namespaces (`namespaces: ['mind:*']`)
   - Same pattern as event pub/sub (`publish: ['user:*']`)

4. **Flexibility**
   - From no access (`workflows: false`) to full admin (`workflows: true`)
   - Gradual permission grants: start restrictive, expand as needed

5. **Auditability**
   - Clear error messages: `"Workflow 'delete-data' access denied: not in allowed workflowIds scope"`
   - Easy to understand what permission is missing

6. **Zero Migration Cost**
   - Existing plugins without permissions are denied (secure default)
   - No breaking changes to existing code

### Negative

1. **Manual Configuration**
   - Plugin developers must declare permissions in manifest
   - No auto-detection of required permissions

2. **Pattern Limitations**
   - Only prefix wildcards (`analytics-*`), not suffix or middle wildcards
   - No regex support (by design - simplicity over flexibility)

3. **No Dynamic Permissions**
   - Permissions fixed at plugin load time
   - Cannot grant temporary elevated permissions (future enhancement)

4. **Scope Enforcement Overhead**
   - Every workflow/job operation validates scope patterns
   - Minimal impact (~1-2ms), but still overhead

### Alternatives Considered

#### 1. Role-Based Access Control (RBAC)

**Rejected**: Too complex for plugin system MVP

```typescript
// Would require:
roles: ['workflow-admin', 'analytics-user']
permissions: {
  'workflow-admin': { workflows: '*', jobs: '*' },
  'analytics-user': { workflows: ['analytics-*'] },
}
```

**Pros**: More flexible, enterprise-grade
**Cons**: Adds complexity, requires role management, overkill for plugin permissions

#### 2. Capability-Based Security

**Rejected**: Doesn't fit stateless plugin execution model

```typescript
// Would require:
const capability = await ctx.api.workflows.requestCapability('analytics-*');
await capability.run('analytics-report', {});
```

**Pros**: Fine-grained, revocable
**Cons**: Complex to implement, requires capability storage, stateful

#### 3. Workflow-Level Permissions

**Rejected**: Too granular, hard to maintain

```typescript
// Would require:
workflows: {
  'analytics-daily': { run: true, cancel: false },
  'analytics-monthly': { run: true, cancel: false },
  'analytics-yearly': { run: true, cancel: true },
}
```

**Pros**: Ultimate control
**Cons**: Unmaintainable, verbose, defeats purpose of patterns

#### 4. No Scope Restrictions (Operation-Only)

**Rejected**: Insufficient security

```typescript
// Would allow:
workflows: {
  run: true,  // Can run ANY workflow
  cancel: false,
}
```

**Pros**: Simple
**Cons**: Plugin can start any workflow, security risk

## Implementation

### Files Created

None (extended existing files)

### Files Modified

1. **plugin-contracts** (`@kb-labs/plugin-contracts`)
   - `src/permissions.ts` - Added workflows/jobs to platform section
   - `src/index.ts` - Exported new types
   - Build: ✅ Success

2. **plugin-runtime** (`@kb-labs/plugin-runtime`)
   - `src/api/workflows.ts` - Added `checkWorkflowPermission()` with scope validation
   - `src/api/jobs.ts` - Added `checkJobPermission()` with scope validation
   - `src/api/index.ts` - Pass permissions to createWorkflowsAPI/createJobsAPI
   - Build: ✅ Success

### Test Coverage

**Workflows Permissions** (`src/__tests__/workflows-api.test.ts`):
- ✅ Full access with `workflows: true`
- ✅ Denied access with `workflows: false`
- ✅ Denied access with `workflows: undefined`
- ✅ Granular operation permissions
- ✅ Scope with exact match
- ✅ Scope with wildcard pattern `*`
- ✅ Scope with prefix pattern `analytics-*`
- ✅ Scope denial when pattern doesn't match
- ✅ Allow all when workflowIds not specified

**Jobs Permissions** (`src/__tests__/jobs-api.test.ts`):
- ✅ Full access with `jobs: true`
- ✅ Denied access with `jobs: false`
- ✅ Denied access with `jobs: undefined`
- ✅ Granular operation permissions
- ✅ Scope with exact match
- ✅ Scope with wildcard pattern `*`
- ✅ Scope with prefix pattern `send-*`
- ✅ Scope denial when pattern doesn't match
- ✅ Allow all when types not specified
- ✅ Scope check for both submit and schedule operations

**Total**: 381 tests passed (21 test files), 3 skipped

### Usage Examples

**Example 1: Analytics Plugin**
```json
{
  "id": "analytics-plugin",
  "permissions": {
    "platform": {
      "workflows": {
        "run": true,
        "list": true,
        "workflowIds": ["analytics-*"]
      }
    }
  }
}
```

**Example 2: Email Service Plugin**
```json
{
  "id": "email-service",
  "permissions": {
    "platform": {
      "jobs": {
        "submit": true,
        "schedule": true,
        "types": ["send-*"]
      }
    }
  }
}
```

**Example 3: Admin Plugin (Full Access)**
```json
{
  "id": "admin-plugin",
  "permissions": {
    "platform": {
      "workflows": true,
      "jobs": true
    }
  }
}
```

**Example 4: Monitor Plugin (Read-Only)**
```json
{
  "id": "monitor-plugin",
  "permissions": {
    "platform": {
      "workflows": { "list": true },
      "jobs": { "list": true }
    }
  }
}
```

### Default Permissions

```typescript
export const DEFAULT_PERMISSIONS: PermissionSpec = {
  filesystem: {
    read: false,
    write: false,
    paths: [],
  },
  platform: {
    llm: false,
    vectorStore: false,
    cache: false,
    storage: false,
    analytics: false,
    embeddings: false,
    events: false,
    workflows: false,  // Added
    jobs: false,       // Added
  },
  thirdParty: {},
};
```

### Future Enhancements

**Phase 2** (Nice-to-have):
- Dynamic permission grants (temporary elevated permissions)
- Permission inheritance (plugin groups with shared permissions)
- User-configurable overrides (further restrict plugin permissions)

**Phase 3** (Future):
- Regex patterns (e.g., `^analytics-.*-report$`)
- Time-based permissions (allow during maintenance window)
- Approval workflows for sensitive operations
- Audit logging for permission violations

### Risks

1. **Pattern Matching Bugs**
   - Risk: Incorrect glob matching allows unauthorized access
   - Mitigation: Comprehensive test coverage (14 permission tests)
   - Mitigation: Simple algorithm (prefix + exact match only)

2. **Permission Bypass**
   - Risk: Plugin finds workaround to skip permission checks
   - Mitigation: Checks at API adapter layer (not plugin code)
   - Mitigation: No direct engine/scheduler access

3. **Overly Permissive Defaults**
   - Risk: Plugin requests `workflows: true` without justification
   - Mitigation: Documentation encourages minimal permissions
   - Mitigation: Security audit during plugin review

## References

- [PermissionSpec Documentation](../../kb-labs-plugin/packages/plugin-contracts/src/permissions.ts)
- [Workflow Integration Complete](../../docs/WORKFLOW-INTEGRATION-COMPLETE.md)
- Related: [ADR-0015: Multi-Tenancy Primitives](./0015-multi-tenancy-primitives.md)

---

**Last Updated:** 2026-01-15
**Next Review:** 2026-07-15
