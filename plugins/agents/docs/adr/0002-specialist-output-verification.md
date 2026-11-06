# ADR-0002: Specialist Output Verification System

**Date:** 2026-01-18
**Status:** Proposed
**Deciders:** KB Labs Team
**Tags:** agents, verification, anti-hallucination, orchestrator

## Context

Agent specialists (researcher, implementer) can hallucinate about task completion - claiming work is done when it's not fully executed. This was observed when the implementer specialist claimed to have added JSDoc to 4 methods but only completed 1.

### The Problem

LLMs have no working memory to track multi-step task progress. After one tool call (e.g., `fs:edit`), they may assume the entire task is complete, leading to:
- **Partial completion** - Only 1 of 4 methods documented
- **False confidence** - Output claims "All 4 methods documented"
- **No objective verification** - Orchestrator trusts specialist output without checking

### Ground Truth Challenge

Unlike Mind RAG (which has retrieved chunks as ground truth), agent tasks have no predetermined "correct answer" to verify against. We cannot know the "right JSDoc" beforehand because the agent is creating new content.

## Decision

Implement a **two-tier verification system** with:

1. **Tier 1: Built-in Tools** - Strict verification using filesystem re-checks
2. **Tier 2: Plugin Tools** - Light verification based on summary and tool calls
3. **Compact artifact format** - Specialists return metadata (line numbers, counts) not full content
4. **Instruction compliance** - Verify that specialist followed task requirements, not correctness of output

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Orchestrator                            │
│                                                              │
│  1. Delegates subtask to Specialist                         │
│  2. Receives SpecialistOutput (compact artifacts)           │
│  3. TaskVerifier validates output                           │
│     ├─ Built-in tools → BuiltInToolVerifier (strict)       │
│     └─ Plugin tools → PluginToolVerifier (light)           │
│  4. Re-runs tools to verify (fs:exists, fs:read regions)   │
│  5. Continues if passed, retries/fails if not              │
└─────────────────────────────────────────────────────────────┘
```

## Tier 1: Built-in Tools (Strict Verification)

**Tools:** `fs:read`, `fs:write`, `fs:edit`, `fs:list`, `fs:exists`, `code:outline`, `code:find-definition`, `code:find-usages`, `shell:exec`

**Verification Strategy:**
- Re-run tools to check actual filesystem state
- Verify files exist using `fs:exists`
- Re-read modified regions using `fs:read` with line ranges
- Check task-specific requirements (e.g., JSDoc presence)
- Confidence: **high** (objective ground truth available)

**Example:**

```typescript
async verifyFsEdit(task: string, output: SpecialistOutput): Promise<VerificationResult> {
  const edits = output.artifacts?.fileEdits ?? [];

  for (const edit of edits) {
    // 1. File exists?
    const exists = await this.tools.fs.exists(edit.file);
    if (!exists) {
      return { passed: false, reason: `File ${edit.file} not found` };
    }

    // 2. Read ONLY edited region (not full file)
    const content = await this.tools.fs.read(edit.file, {
      startLine: edit.editedRegion.start,
      endLine: edit.editedRegion.end
    });

    // 3. Task-specific check
    if (task.includes('Add JSDoc')) {
      const hasJSDoc = this.checkJSDoc(content);
      if (!hasJSDoc) {
        return { passed: false, reason: 'JSDoc not found' };
      }
    }
  }

  return { passed: true, confidence: 'high' };
}
```

## Tier 2: Plugin Tools (Light Verification)

**Tools:** ALL plugins including `mind:rag-query`, `workflow:run`, `deploy:production`, custom plugins

**Verification Strategy:**
- Check tool was called (`output.toolCalls.includes(tool)`)
- Verify summary is not empty
- Check for error keywords in summary ('error', 'failed', 'exception')
- NO content validation (black box systems)
- Confidence: **medium** (process compliance only)

**Example:**

```typescript
verifyPluginTool(tool: string, output: SpecialistOutput): VerificationResult {
  // 1. Tool called?
  if (!output.toolCalls?.includes(tool)) {
    return { passed: false, reason: `Tool ${tool} not called` };
  }

  // 2. Summary exists?
  if (!output.summary || output.summary.trim().length === 0) {
    return { passed: false, reason: 'No summary provided' };
  }

  // 3. No error keywords?
  const errorKeywords = ['error', 'failed', 'exception', 'crash'];
  for (const keyword of errorKeywords) {
    if (output.summary.toLowerCase().includes(keyword)) {
      return { passed: false, reason: `Summary indicates failure` };
    }
  }

  return { passed: true, confidence: 'medium' };
}
```

## Compact Artifact Format

To prevent context overflow in Orchestrator (with 5+ subtasks), specialists return **metadata only**:

### Before (❌ Context overflow):
```json
{
  "artifacts": {
    "originalContent": "... 500 lines of code ...",  // 15 KB
    "modifiedContent": "... 500 lines of code ..."   // 15 KB
  }
}
// Total: ~30 KB per specialist
```

### After (✅ 150x smaller):
```json
{
  "artifacts": {
    "fileEdits": [{
      "file": "tree-sitter-parser.ts",
      "linesChanged": 15,
      "editedRegion": { "start": 45, "end": 60 },
      "changeType": "add"
    }]
  }
}
// Total: ~200 bytes per specialist
```

### Full Artifact Schema

```typescript
interface SpecialistOutput {
  summary: string;
  created?: string[];
  modified?: string[];
  deleted?: string[];
  toolCalls?: string[];
  commands?: string[];
  testResult?: 'passed' | 'failed' | 'skipped';

  artifacts?: {
    fileEdits?: Array<{
      file: string;
      linesChanged: number;
      editedRegion: { start: number; end: number };
      changeType: 'add' | 'modify' | 'delete';
    }>;

    filesCreated?: Array<{
      file: string;
      sizeBytes: number;
      linesCount: number;
    }>;

    commandResults?: Array<{
      command: string;
      exitCode: number;
      stdoutLines: number;  // Count, not content
      stderrLines: number;
    }>;

    pluginResults?: Array<{
      tool: string;
      status: 'success' | 'error';
      confidence?: number;
      itemsReturned?: number;
    }>;
  };
}
```

## Verification Flow

```typescript
class TaskVerifier {
  async verify(task: string, output: SpecialistOutput): Promise<VerificationResult> {
    const toolsUsed = output.toolCalls ?? [];
    const results: VerificationResult[] = [];

    for (const tool of toolsUsed) {
      if (this.isBuiltIn(tool)) {
        // Tier 1: Strict verification
        const result = await this.verifyBuiltInTool(tool, task, output);
        results.push(result);
      } else {
        // Tier 2: Light verification
        const result = this.verifyPluginTool(tool, output);
        results.push(result);
      }
    }

    const allPassed = results.every(r => r.passed);
    const confidence = this.calculateConfidence(results);

    return { passed: allPassed, confidence, details: results };
  }

  private isBuiltIn(tool: string): boolean {
    return tool.startsWith('fs:') ||
           tool.startsWith('code:') ||
           tool.startsWith('shell:');
  }
}
```

## Consequences

### Positive

- **Anti-hallucination**: Catches incomplete work before orchestrator proceeds
- **Context efficiency**: 150x smaller artifacts (30 KB → 200 bytes per specialist)
- **Scalability**: Orchestrator can handle 50+ subtasks without context overflow
- **Two-tier approach**: Strict where possible, pragmatic for black boxes
- **No plugin contracts needed**: Light verification works for any plugin

### Negative

- **Additional latency**: +50-100ms per verification (re-running tools)
- **Not 100% accurate**: Light verification can miss issues in plugin outputs
- **Agent burden**: Must track metadata (line counts, regions) during execution

### Alternatives Considered

1. **LLM self-verification** - "Check your own work"
   - ❌ Rejected: LLMs poor at detecting own hallucinations

2. **Full artifact storage** - Keep entire file contents
   - ❌ Rejected: Context overflow with 5+ subtasks

3. **No verification** - Trust specialist output
   - ❌ Rejected: High hallucination rate (~20% from testing)

4. **Plugin contract parsing** - Load output schemas for all plugins
   - ❌ Rejected: Too complex, fragile, hard to maintain

## Runtime Schema Validation

All specialist outputs undergo **three-level validation**:

### Level 1: SpecialistOutput Schema (Always)

```typescript
const SpecialistOutputSchema = z.object({
  summary: z.string().min(1),
  created: z.array(z.string()).optional(),
  modified: z.array(z.string()).optional(),
  toolCalls: z.array(z.string()).optional(),
  artifacts: z.object({
    pluginResults: z.array(z.object({
      tool: z.string(),
      status: z.enum(['success', 'error']),
      data: z.unknown(),  // Raw plugin output, validated separately
      error: z.string().optional()
    })).optional()
  }).optional()
});
```

### Level 2: Plugin Output Schema (From Contracts)

Plugins already define Zod schemas in their contracts:

```typescript
// kb-labs-commit-plugin/packages/commit-contracts/src/schema.ts
export const ResetOutputSchema = z.object({
  message: z.string(),
  filesCleared: z.number()
});

// kb-labs-commit-plugin/packages/commit-contracts/src/contract.ts
'commit:reset': {
  output: {
    ref: '@kb-labs/commit/contracts/schema#ResetOutput',  // Reference to schema
    format: 'zod'
  }
}
```

**Schema Resolution**: Load schema dynamically from contract ref:

```typescript
class PluginSchemaLoader {
  async loadSchema(ref: string): Promise<z.ZodSchema | null> {
    // Parse ref: '@kb-labs/commit/contracts/schema#ResetOutput'
    const [packageName, path, exportName] = parseRef(ref);

    // Dynamic import
    const module = await import(packageName);
    const schema = module[`${exportName}Schema`];  // ResetOutputSchema

    return schema ?? null;
  }
}
```

### Level 3: Content Validation (Built-in Tools Only)

For `fs:*`, `code:*`, `shell:*` tools - re-run tools to verify filesystem state.

### Validation Flow

```typescript
class TaskVerifier {
  private schemaLoader = new PluginSchemaLoader();

  async verify(task: string, rawOutput: unknown): Promise<VerificationResult> {
    // LEVEL 1: SpecialistOutput structure
    const parseResult = SpecialistOutputSchema.safeParse(rawOutput);
    if (!parseResult.success) {
      return { passed: false, reason: 'Invalid output structure', details: parseResult.error };
    }

    const output = parseResult.data;

    // LEVEL 2: Plugin outputs (if any)
    if (output.artifacts?.pluginResults) {
      for (const pluginResult of output.artifacts.pluginResults) {
        const commandContract = await this.getCommandContract(pluginResult.tool);

        if (commandContract?.output?.ref) {
          const schema = await this.schemaLoader.loadSchema(commandContract.output.ref);

          if (schema) {
            const pluginParseResult = schema.safeParse(pluginResult.data);
            if (!pluginParseResult.success) {
              return {
                passed: false,
                reason: `Plugin ${pluginResult.tool} output validation failed`,
                details: pluginParseResult.error
              };
            }
          }
        }
      }
    }

    // LEVEL 3: Content validation (built-in tools only)
    for (const tool of output.toolCalls ?? []) {
      if (this.isBuiltIn(tool)) {
        const result = await this.verifyBuiltInTool(tool, task, output);
        if (!result.passed) return result;
      }
    }

    return { passed: true, confidence: 'high' };
  }
}
```

## Implementation Plan

### Phase 1: Core Verification System
- [ ] Create `TaskVerifier` class in `kb-labs-agents/packages/agent-core/src/verification/`
- [ ] Implement `BuiltInToolVerifier` with fs:*, code:*, shell:* checks
- [ ] Implement `PluginSchemaLoader` for dynamic schema loading from contracts
- [ ] Add `SpecialistOutputSchema` Zod schema
- [ ] Add `VerificationResult` interface to agent contracts

### Phase 2: Specialist Config Updates
- [ ] Update `implementer/specialist.yml` with compact artifact format
- [ ] Update `researcher/specialist.yml` with compact artifact format
- [ ] Add artifact metadata tracking instructions to system prompts
- [ ] Add `pluginResults.data` field for raw plugin outputs

### Phase 3: Orchestrator Integration
- [ ] Integrate `TaskVerifier` into orchestrator subtask execution
- [ ] Add 3-level validation (structure → plugin schemas → content)
- [ ] Handle verification failures (retry logic, error reporting)
- [ ] Cache loaded plugin schemas for performance

### Phase 4: Testing
- [ ] Test Level 1: Invalid SpecialistOutput structure
- [ ] Test Level 2: Invalid plugin output (mind:rag-query with wrong schema)
- [ ] Test Level 3: fs:edit verification (JSDoc task)
- [ ] Test mixed tasks (fs:edit + mind:rag-query with both validations)
- [ ] Measure context savings (before/after artifact sizes)

## Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| Hallucination detection rate | 0% | >80% |
| Artifact size per specialist | ~30 KB | <500 bytes |
| Verification latency | N/A | <100ms |
| False positive rate | N/A | <10% |

## Related

- [ADR-0001: Tool Strategy System](./0001-tool-strategy-system.md)
- Mind RAG Anti-Hallucination: `kb-labs-mind/docs/adr/0031-anti-hallucination-system.md`
- Specialist Configs: `.kb/specialists/*/specialist.yml`

## Files to Create/Modify

| File | Type | Description |
|------|------|-------------|
| `kb-labs-agents/packages/agent-core/src/verification/task-verifier.ts` | NEW | Main verifier class |
| `kb-labs-agents/packages/agent-core/src/verification/built-in-verifier.ts` | NEW | Tier 1 verification |
| `kb-labs-agents/packages/agent-core/src/verification/plugin-verifier.ts` | NEW | Tier 2 verification |
| `kb-labs-agents/packages/agent-core/src/verification/index.ts` | NEW | Exports |
| `.kb/specialists/implementer/specialist.yml` | MODIFY | Add compact artifact format |
| `.kb/specialists/researcher/specialist.yml` | MODIFY | Add compact artifact format |
| `kb-labs-agents/packages/agent-orchestrator/src/orchestrator.ts` | MODIFY | Integrate verification |

---

**Last Updated:** 2026-01-18
