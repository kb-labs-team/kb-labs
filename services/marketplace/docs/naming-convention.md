# Naming Convention: The Pyramid Rule

**Status:** Mandatory
**Applies to:** All packages in KB Labs ecosystem
**Date:** 2025-11-30

---

## The Pyramid Rule

All packages in the KB Labs ecosystem follow a strict naming convention called **"The Pyramid Rule"**:

```
@kb-labs/{repo}-{package}
```

Where:
- `{repo}` - the monorepo name (e.g., `core`, `cli`, `shared`, `plugin`)
- `{package}` - the package name within that repo

**Critical:** The folder name MUST ALWAYS match `{repo}-{package}`.

---

## The Pyramid Structure

```
     @kb-labs              ← Base namespace (all packages)
        ↓
     {repo}                ← Repository name (core, cli, shared, plugin)
        ↓
    {package}              ← Package name
```

**Example:**
```
Repository:  kb-labs-core
Package:     config
Result:      @kb-labs/core-config
Folder:      kb-labs-core/packages/core-config/
```

---

## Rules

### ✅ DO

**1. Always use the repo prefix in folder names:**
```
kb-labs-core/packages/core-config/      → @kb-labs/core-config ✅
kb-labs-cli/packages/cli-core/          → @kb-labs/cli-core ✅
kb-labs-shared/packages/shared-diff/    → @kb-labs/shared-diff ✅
```

**2. Keep folder name and package name in sync:**
```json
// In kb-labs-core/packages/core-config/package.json
{
  "name": "@kb-labs/core-config"  // Matches folder: core-config
}
```

**3. Use descriptive package names:**
```
core-state-broker      ✅  (clear what it does)
core-framework         ✅  (indicates it's infrastructure)
core-cli               ✅  (CLI commands for core)
```

### ❌ DON'T

**1. Skip the repo prefix:**
```
kb-labs-core/packages/config/           → @kb-labs/core-config ❌
kb-labs-core/packages/sys/              → @kb-labs/core-sys ❌
```
**Problem:** Folder name doesn't match package name pattern.

**2. Use inconsistent naming:**
```
kb-labs-core/packages/cli-core/         → @kb-labs/core-cli ❌
```
**Problem:** Folder is `cli-core` but package is `core-cli` (inverted).

**3. Create packages without repo prefix:**
```
kb-labs-core/packages/bundle/           → @kb-labs/bundle ❌
```
**Problem:** Missing `core-` prefix in both folder and package name.

---

## Examples by Repository

### kb-labs-core

All packages MUST have `core-` prefix:

```
✅ core-bundle/         → @kb-labs/core-bundle
✅ core-cli/            → @kb-labs/core-cli
✅ core-config/         → @kb-labs/core-config
✅ core-framework/      → @kb-labs/core-framework
✅ core-state-broker/   → @kb-labs/core-state-broker
✅ core-sys/            → @kb-labs/core-sys
✅ core-types/          → @kb-labs/core-types
```

### kb-labs-cli

All packages MUST have `cli-` prefix:

```
✅ cli-api/             → @kb-labs/cli-api
✅ cli-commands/        → @kb-labs/cli-commands
✅ cli-contracts/       → @kb-labs/cli-contracts
✅ cli-core/            → @kb-labs/cli-core
✅ cli-runtime/         → @kb-labs/cli-runtime
```

### kb-labs-shared

All packages MUST have `shared-` prefix:

```
✅ shared-command-kit/  → @kb-labs/shared-command-kit
✅ shared-cli-ui/       → @kb-labs/shared-cli-ui
✅ shared-diff/         → @kb-labs/shared-diff
✅ shared-repo/         → @kb-labs/shared-repo
```

### kb-labs-plugin

All packages MUST have `plugin-` prefix:

```
✅ plugin-manifest/     → @kb-labs/plugin-manifest
✅ plugin-runtime/      → @kb-labs/plugin-runtime
✅ plugin-adapter-cli/  → @kb-labs/plugin-adapter-cli
```

---

## Special Cases

### Multi-word package names

Use kebab-case for multi-word names:

```
✅ core-state-broker/       → @kb-labs/core-state-broker
✅ core-cli-adapters/       → @kb-labs/core-cli-adapters
✅ plugin-adapter-rest/     → @kb-labs/plugin-adapter-rest
```

### Adapters and sub-packages

Adapters can be nested but still follow the rule:

```
✅ kb-labs-plugin/packages/plugin-adapter-cli/
✅ kb-labs-plugin/packages/plugin-adapter-rest/
✅ kb-labs-core/packages/core-cli-adapters/
```

---

## Migration Checklist

When creating a new package or fixing naming violations:

- [ ] Folder name follows `{repo}-{package}` pattern
- [ ] `package.json` name matches `@kb-labs/{repo}-{package}`
- [ ] Folder name and package name are in sync
- [ ] All `link:` dependencies updated to new paths
- [ ] All `workspace:*` dependencies updated to new names
- [ ] Documentation updated (README, imports)
- [ ] `pnpm install` runs without errors

---

## Validation

### Check for violations

```bash
# List all packages and check naming
find kb-labs-*/packages -name package.json -exec grep -H '"name":' {} \;

# Expected pattern: kb-labs-{repo}/packages/{repo}-{package}/package.json
```

### Common violations

1. **Missing repo prefix in folder:**
   ```
   kb-labs-core/packages/config/  ❌
   Should be: core-config/
   ```

2. **Inverted naming:**
   ```
   kb-labs-core/packages/cli-core/ with @kb-labs/core-cli  ❌
   Should be: core-cli/ or rename package
   ```

3. **Missing repo prefix in package name:**
   ```
   "name": "@kb-labs/sandbox"  ❌
   Should be: "@kb-labs/core-sandbox"
   ```

---

## Benefits

### 1. Zero Ambiguity
- No confusion about where a package belongs
- `@kb-labs/core-config` → clearly in `kb-labs-core`
- `@kb-labs/cli-core` → clearly in `kb-labs-cli`

### 2. Easy Navigation
- Folder structure mirrors package names
- `import from '@kb-labs/core-sys'` → look in `kb-labs-core/packages/core-sys/`

### 3. Prevents Collisions
- Before: two packages could have `@kb-labs/core-cli` (collision!)
- After: impossible - repo prefix enforces uniqueness

### 4. Scalability
- New repos automatically follow pattern
- `kb-labs-ai/packages/ai-docs/` → `@kb-labs/ai-docs`

---

## History

**Before (Problematic):**
```
kb-labs-core/packages/sys/              → @kb-labs/core-sys
kb-labs-core/packages/cli/              → @kb-labs/core-cli
kb-labs-core/packages/cli-core/         → @kb-labs/core-cli  ← COLLISION!
kb-labs-cli/packages/core/              → @kb-labs/cli-core
kb-labs-cli/packages/cli-core/          → @kb-labs/cli-core  ← WRAPPER
```

**After (Clean):**
```
kb-labs-core/packages/core-sys/         → @kb-labs/core-sys
kb-labs-core/packages/core-cli/         → @kb-labs/core-cli
kb-labs-core/packages/core-framework/   → @kb-labs/core-framework
kb-labs-cli/packages/cli-core/          → @kb-labs/cli-core
```

**Changes made (2025-11-30):**
- Renamed 13 packages in `kb-labs-core`
- Renamed 1 package in `kb-labs-cli`
- Moved `command-kit` to `kb-labs-shared`
- Eliminated name collision between framework and CLI commands
- Updated 50+ dependency references

---

## See Also

- [Documentation Guide](./DOCUMENTATION.md) - How to document your product
- [ADRs](./adr/) - Architecture Decision Records

---

**Questions?** Check with the team or open an issue if the naming convention is unclear.
