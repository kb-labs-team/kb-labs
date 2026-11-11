# ADR-0001: Structured Agent Output via Tool Calling

**Status**: Proposed
**Date**: 2026-01-19
**Decision Makers**: Core Team
**Priority**: P0 - Critical for Reliability

---

## Context

Current agent system suffers from unreliable output parsing:

### Problem

Agents return unstructured text responses that must be parsed:

```
Agent → LLM → "Here's my analysis... {maybe some JSON?}" → JSON.parse() → ❌ FAILS
```

**Failure modes**:
- Agent forgets to return JSON
- Returns invalid JSON (trailing commas, unescaped strings)
- Wraps JSON in markdown code blocks
- Returns text instead of structured data
- Missing required fields

**Current success rate**: ~50% (as seen in test run - implementer failed validation)

**Error example**:
```
❌ Verification failed: Level 1 (structure) validation failed, summary: Required
```

### Why This Matters

For production use, we need **predictable, reliable execution**. If agents don't return structured results:
- Orchestrator can't synthesize findings
- Partial results are lost
- User gets "task failed" instead of useful output
- No way to validate data quality

---

## Decision

**Replace text-based output with tool-based structured output.**

Agents will call a `submit_result` tool to return findings, instead of returning unstructured text.

### Architecture

```typescript
// Instead of this (unreliable):
Agent → LLM → text response → parse JSON → maybe works?

// Do this (reliable):
Agent → LLM → tool call: submit_result({structured data}) → ✅ validated by Zod
```

---

## Design

### 1. Agent Config Schema Extension

Add `output` section to agent YAML configs:

```yaml
# .kb/agents/researcher/agent.yml
schema: 'kb.agent/1'
id: researcher
name: Code Researcher

# ... existing config ...

# NEW: Output schema (JSON Schema format)
output:
  schema:
    type: object
    required: [summary, findings]
    properties:
      summary:
        type: string
        description: Brief summary of research findings
        minLength: 50
      findings:
        type: array
        description: List of discovered facts
        items:
          type: object
          required: [description, files, evidence, confidence]
          properties:
            description: { type: string }
            files:
              type: array
              items: { type: string }
            evidence: { type: string }
            confidence:
              type: string
              enum: [low, medium, high]
      relevantFiles:
        type: array
        items: { type: string }
      nextSteps:
        type: array
        items: { type: string }
```

### 2. JSON Schema → Zod Converter

```typescript
// agent-core/src/schema-converter.ts
export function jsonSchemaToZod(jsonSchema: any): z.ZodType {
  // Runtime conversion: JSON Schema → Zod Schema
  // Supports: object, array, string, number, boolean, enum
  // Validates: minLength, maxLength, min, max, pattern, required
}
```

### 3. Dynamic Output Tool Builder

```typescript
// agent-core/src/output-tool-builder.ts
export function buildOutputTool(agentConfig: AgentConfigV1): OutputTool | null {
  if (!agentConfig.output?.schema) {
    return null; // Legacy mode: free-form text
  }

  const zodSchema = jsonSchemaToZod(agentConfig.output.schema);

  return {
    name: 'submit_result',
    description: 'Submit final results. You MUST call this tool!',
    schema: zodSchema,
    execute: async (input) => ({ success: true, data: input })
  };
}
```

### 4. Agent Executor Integration

```typescript
// agent-executor/src/agent-executor.ts
export async function executeAgent(agentConfig, task, context) {
  // Build tools
  const inputTools = buildInputTools(agentConfig.tools);  // fs:*, mind:*, etc
  const outputTool = buildOutputTool(agentConfig);        // submit_result

  const allTools = outputTool ? [...inputTools, outputTool] : inputTools;

  // Enhanced prompt
  const systemPrompt = outputTool
    ? `${agentConfig.context.static.system}\n\n# ⚠️ CRITICAL: You MUST call submit_result() to return findings!`
    : agentConfig.context.static.system;

  // Execute
  const result = await llm.chatWithTools({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task }
    ],
    tools: allTools,
    maxSteps: agentConfig.limits.maxSteps
  });

  // Extract structured result
  if (outputTool) {
    const submitCall = result.toolCalls.find(tc => tc.name === 'submit_result');
    if (!submitCall) {
      throw new Error(`Agent did not call submit_result tool`);
    }
    return submitCall.output; // Already validated by Zod!
  }

  // Legacy: free-form text
  return { answer: result.content };
}
```

### 5. Validation

```typescript
// agent-core/src/validator.ts
export function validateAgentOutputSchema(agentConfig) {
  if (!agentConfig.output?.schema) return; // Optional

  // Must be object type
  if (agentConfig.output.schema.type !== 'object') {
    throw new Error('output.schema.type must be "object"');
  }

  // Must have properties
  if (!agentConfig.output.schema.properties) {
    throw new Error('output.schema must have properties');
  }

  // Test conversion
  try {
    jsonSchemaToZod(agentConfig.output.schema);
  } catch (err) {
    throw new Error(`Invalid JSON Schema: ${err.message}`);
  }
}
```

---

## Benefits

### 1. Reliability ✅
- **100% structured output** - impossible to return invalid format
- **Zod validation** - catches missing/wrong fields at runtime
- **Clear errors** - "Missing field X" instead of "Parse failed"

**Expected improvement**: 50% → 95%+ success rate

### 2. Predictability ✅
- **Known schema** - always know what you'll get
- **Type safety** - TypeScript knows the shape
- **No parsing hell** - no brittle JSON.parse()

### 3. Debuggability ✅
- **Tool call visible** in analytics
- **Can inspect** exact data agent tried to submit
- **Retry with correction** if validation fails

### 4. Backward Compatibility ✅
- **No `output` config** → Legacy mode (free-form text)
- **Has `output` config** → Structured mode (tool calling)
- **Incremental migration** - update agents one by one

### 5. Evolution ✅
- **Easy to extend** - add optional field to schema
- **Versioning** - can support multiple schema versions
- **Graceful degradation** - optional fields allow evolution

---

## Implementation Plan

### Phase 0: Core Infrastructure (2-3 hours)

**Files to create**:
```
agent-core/src/
  ├── schema-converter.ts          # JSON Schema → Zod
  ├── output-tool-builder.ts       # Dynamic tool builder
  └── validator.ts                 # Config validation
```

**Tasks**:
- [ ] Implement `jsonSchemaToZod()` converter
  - Support: object, array, string, number, boolean, enum
  - Support: minLength, maxLength, min, max, pattern, required
  - Add tests for edge cases
- [ ] Implement `buildOutputTool()` factory
  - Generate tool from agent config
  - Consistent naming: `submit_result`
  - Auto-validation via Zod
- [ ] Implement `validateAgentOutputSchema()`
  - Run at agent load time
  - Clear error messages
  - Validate JSON Schema is convertible

### Phase 1: Agent Executor Update (1-2 hours)

**Files to modify**:
```
agent-executor/src/
  └── agent-executor.ts            # Update executeAgent()
```

**Tasks**:
- [ ] Integrate output tool builder
- [ ] Enhance system prompt when output tool exists
- [ ] Extract result from `submit_result` tool call
- [ ] Throw clear error if agent didn't call tool
- [ ] Maintain backward compatibility (no output schema = legacy)

### Phase 2: Schema Updates (30 min)

**Files to modify**:
```
agent-contracts/src/
  ├── agent-config.ts              # Add OutputSchema type
  ├── agent-schemas.ts             # Add AgentOutputSchemaSchema
  └── index.ts                     # Export new types
```

**Tasks**:
- [ ] Add `output?: { schema: unknown }` to AgentConfigV1
- [ ] Update Zod schema validation
- [ ] Export types for TypeScript

### Phase 3: Agent Config Migration (1 hour)

**Files to update**:
```
.kb/agents/
  ├── researcher/agent.yml         # Add output schema
  ├── implementer/agent.yml        # Add output schema
  ├── reviewer/agent.yml           # Add output schema
  └── tester/agent.yml             # Add output schema
```

**Example schemas**:

**Researcher**:
```yaml
output:
  schema:
    type: object
    required: [summary, findings]
    properties:
      summary: { type: string, minLength: 50 }
      findings:
        type: array
        items:
          type: object
          required: [description, files, evidence, confidence]
      relevantFiles: { type: array, items: { type: string } }
```

**Implementer**:
```yaml
output:
  schema:
    type: object
    required: [summary, filesModified]
    properties:
      summary: { type: string }
      filesModified:
        type: array
        items:
          type: object
          required: [path, action, changes]
          properties:
            path: { type: string }
            action: { type: string, enum: [created, modified, deleted] }
            changes: { type: string }
      testsCovered: { type: boolean }
```

**Reviewer**:
```yaml
output:
  schema:
    type: object
    required: [summary, issues, approved]
    properties:
      summary: { type: string }
      issues:
        type: array
        items:
          type: object
          required: [severity, description]
      overallQuality: { type: string, enum: [excellent, good, needs-work, poor] }
      approved: { type: boolean }
```

**Tester**:
```yaml
output:
  schema:
    type: object
    required: [summary, testsCreated, coverage]
    properties:
      summary: { type: string }
      testsCreated:
        type: array
        items:
          type: object
          required: [path, testCount, type]
      coverage: { type: number, minimum: 0, maximum: 100 }
```

### Phase 4: Testing & Validation (30 min)

**Tasks**:
- [ ] Test agent list (validates all configs)
  ```bash
  pnpm kb agent:list
  # Should validate output schemas
  ```
- [ ] Test simple task
  ```bash
  pnpm kb agent:run --task="Find all analytics events"
  # Researcher should call submit_result()
  ```
- [ ] Test complex task
  ```bash
  pnpm kb agent:run --task="Analyze auth flow and suggest improvements"
  # Multiple agents, all should submit structured results
  ```
- [ ] Check analytics for failures
  ```bash
  grep "did not call submit_result" <KB_HOME>/state/<projectId>/analytics/buffer/*.jsonl
  # Should be zero!
  ```

### Phase 5: Build & Deploy (15 min)

```bash
# Build affected packages
pnpm --filter @kb-labs/agents/core run build
pnpm --filter @kb-labs/agents/contracts run build
pnpm --filter @kb-labs/agent-executor run build
pnpm --filter @kb-labs/agents/cli run build

# Test
pnpm kb agent:list
pnpm kb agent:run --task="Simple test"
```

---

## Text-Based Patterns to Eliminate

### Current System Analysis

Let's audit where else we rely on unreliable text parsing:

#### 1. **Orchestrator Planning** ✅ Already using tools!
```typescript
// orchestrator.ts - GOOD! Uses create_execution_plan tool
const plan = await llm.chatWithTools({
  tools: [createExecutionPlanTool],
  // ...
})
```
**Status**: ✅ Already structured via tool calling

#### 2. **Agent Output** ❌ Currently text-based
```typescript
// agent-executor.ts - BAD! Expects text response
const result = await llm.chat({ ... })
return parseAgentOutput(result.content) // ❌ FRAGILE
```
**Status**: ❌ **THIS ADR FIXES THIS**

#### 3. **Synthesis** ⚠️ Text-based, but acceptable
```typescript
// orchestrator.ts - synthesis step
const synthesis = await llm.chat({
  messages: [
    { role: 'system', content: 'Synthesize findings...' },
    { role: 'user', content: JSON.stringify(subtaskResults) }
  ]
})
return synthesis.content // User-facing text
```
**Status**: ⚠️ **Acceptable** - this is final user-facing output, not parsed

**Recommendation**: Keep as-is. Synthesis is meant to be natural language for end user.

#### 4. **Mind RAG Queries** ✅ Structured input/output
```typescript
// mind:rag-query already returns structured JSON
const result = await mindRagQuery({ text: "...", mode: "auto" })
// result is typed object, not parsed text
```
**Status**: ✅ Already structured

#### 5. **Tool Results** ✅ All structured
- `fs:read` → string content (not parsed)
- `fs:list` → array of paths
- `fs:search` → array of matches
- `mind:rag-query` → typed object

**Status**: ✅ All tools return structured data

### Summary: What Needs Fixing

| Component | Current State | Action |
|-----------|--------------|--------|
| **Orchestrator planning** | ✅ Tool-based | None - already good |
| **Agent output** | ❌ Text parsing | **Fix with this ADR** |
| **Synthesis** | ⚠️ Text output | Keep - user-facing |
| **Mind RAG** | ✅ Structured | None - already good |
| **Tools** | ✅ Structured | None - already good |

**Conclusion**: Agent output is the ONLY critical text-parsing bottleneck! Fixing this will bring system to 95%+ reliability.

---

## Risks & Mitigation

### Risk 1: LLM Doesn't Call submit_result

**Likelihood**: Low (tool calling is very reliable with Claude)
**Impact**: High (task fails)

**Mitigation**:
- Strong system prompt: "⚠️ CRITICAL: You MUST call submit_result()"
- Clear tool description
- If fails, escalate to larger tier (retry with better model)
- Log analytics event for monitoring

### Risk 2: JSON Schema Conversion Edge Cases

**Likelihood**: Medium (complex schemas might not convert)
**Impact**: Medium (agent config validation fails)

**Mitigation**:
- Comprehensive tests for schema converter
- Clear validation errors at config load time
- Support most common JSON Schema features first
- Document unsupported features

### Risk 3: Breaking Existing Agents

**Likelihood**: Low (backward compatible)
**Impact**: Low (old agents still work)

**Mitigation**:
- **Backward compatible**: No `output` config = legacy mode
- Incremental migration: update agents one by one
- Test both modes in parallel

### Risk 4: Schema Evolution

**Likelihood**: High (schemas will change over time)
**Impact**: Low (optional fields handle this)

**Mitigation**:
- Use optional fields for new properties
- Version schemas if breaking changes needed
- Document migration path

---

## Success Metrics

### Before (Baseline)
- **Success rate**: ~50% (implementer failed in test)
- **Error type**: "Verification failed: structure validation"
- **Debug difficulty**: Hard - can't see what agent returned

### After (Target)
- **Success rate**: ≥95% (tool calling is very reliable)
- **Error type**: "Missing field X" (clear, actionable)
- **Debug difficulty**: Easy - tool call visible in trace

### Monitoring
```bash
# Track success rate
grep "orchestrator.specialist.completed" <KB_HOME>/state/<projectId>/analytics/buffer/*.jsonl | \
  jq -s 'group_by(.payload.specialist_id) |
         map({specialist: .[0].payload.specialist_id,
              total: length,
              success: map(select(.payload.success)) | length})'

# Track submit_result failures
grep "did not call submit_result" <KB_HOME>/state/<projectId>/analytics/buffer/*.jsonl | wc -l
# Target: 0

# Track validation errors
grep "Verification failed" <KB_HOME>/state/<projectId>/analytics/buffer/*.jsonl | wc -l
# Target: near 0
```

---

## Alternatives Considered

### Alternative 1: Stricter Text Prompting
**Approach**: Better prompts to make LLM return valid JSON

**Rejected because**:
- Still relies on parsing (fragile)
- No runtime validation
- Hard to debug failures
- LLMs are creative - will find ways to break format

### Alternative 2: Multiple Validation Attempts
**Approach**: If parse fails, ask LLM to fix format

**Rejected because**:
- Wastes tokens on retry
- Still fundamentally unreliable
- Adds latency
- Tool calling solves this elegantly

### Alternative 3: Hardcoded Output Schemas
**Approach**: Define schemas in TypeScript, not YAML

**Rejected because**:
- Not flexible - requires code changes
- Can't customize per-agent easily
- Goal is data-driven system
- YAML configs are easier for non-devs

---

## References

- **OpenAI Function Calling**: https://platform.openai.com/docs/guides/function-calling
- **Anthropic Tool Use**: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- **JSON Schema Spec**: https://json-schema.org/specification
- **Zod Documentation**: https://zod.dev/

---

## Decision

**APPROVED** pending implementation.

This is a **critical architectural improvement** that will transform reliability from ~50% to 95%+. The approach is:
- ✅ Fully data-driven (no hardcoding)
- ✅ Backward compatible (incremental migration)
- ✅ Type-safe (Zod validation)
- ✅ Debuggable (tool calls visible)
- ✅ Extensible (easy to evolve schemas)

**Next steps**:
1. Implement core infrastructure (schema converter, tool builder)
2. Update agent executor
3. Migrate agent configs
4. Test and validate
5. Monitor success rate in analytics

**Timeline**: 1 day focused work

**Priority**: P0 - blocks production readiness

---

**Last Updated**: 2026-01-19
**Status**: Proposed → Implementation Phase
**Blocking**: Phase 1 of Production Roadmap
