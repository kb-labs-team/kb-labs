/**
 * Builds the system prompt for the agent LLM call.
 *
 * Architecture inspired by Claude Code:
 * - Static sections (core rules, workflow) — stable across sessions, cacheable
 * - Semi-static sections (working dir, delegation) — stable within session
 * - Dynamic sections (memory, facts, workspace) — change per iteration
 *
 * Tool descriptions are NOT in the system prompt — they go via API `tools:` parameter.
 * Project instructions (AGENTS.md) loaded conditionally based on task scope.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentMemory } from '../../contracts/index.js';
import type { WorkspaceDiscoveryResult } from '../execution/workspace-discovery.js';

const MAX_INSTRUCTIONS_CHARS = 4_000; // reduced from 12K — AGENTS.md was 6.5K
const INSTRUCTION_FILE_NAMES = ['AGENT.md', 'KB_AGENT.md', '.agent.md', 'CLAUDE.md'];

export interface SystemPromptInput {
  workingDir: string;
  responseMode: 'auto' | 'brief' | 'deep';
  isSubAgent: boolean;
  sessionId?: string;
  sessionRootDir?: string;
  currentTask?: string;
  memory?: AgentMemory;
  workspaceDiscovery?: WorkspaceDiscoveryResult | null;
  factSheetContent?: string;
  archiveSummaryHint?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Section cache — static sections computed once per process, reused across calls
// ═════════════════════════════════════════════════════════════════════════════

let _cachedStaticPrompt: string | null = null;

export function clearSystemPromptCache(): void {
  _cachedStaticPrompt = null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Builder
// ═════════════════════════════════════════════════════════════════════════════

export class SystemPromptBuilder {
  async build(input: SystemPromptInput): Promise<string> {
    const sections: string[] = [];

    // ── STATIC: core rules + workflow (cacheable, ~4K chars) ──
    sections.push(getStaticPrompt());

    // ── SEMI-STATIC: per-session context ──
    sections.push(buildSessionContext(input));

    // ── DYNAMIC: per-iteration context ──
    const dynamic = await buildDynamicContext(input);
    if (dynamic) { sections.push(dynamic); }

    return sections.join('\n\n');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// STATIC SECTION — stable across sessions, computed once
// ═════════════════════════════════════════════════════════════════════════════

function getStaticPrompt(): string {
  if (_cachedStaticPrompt) { return _cachedStaticPrompt; }
  _cachedStaticPrompt = buildStaticPrompt();
  return _cachedStaticPrompt;
}

function buildStaticPrompt(): string {
  return `You are an autonomous software engineering agent. You execute tasks end-to-end: research, implement, verify.

# Core rules

- NEVER answer from memory as primary evidence. Memory is for continuity; files/tools are evidence.
- Read files before editing. Understand existing code before modifying.
- Verify your work. After editing, read the file back to confirm changes applied correctly.
- ALWAYS prefer fs_replace for modifying existing files — it sends only the diff, not the whole file. Use the smallest match text that uniquely identifies the target (2-4 lines). Only use fs_write for creating NEW files. Never rewrite an entire existing file with fs_write when you can make targeted fs_replace edits.
- When stuck, try a different approach. Don't repeat the same failed action.
- If the task specifies a target directory or working path, use it as the base for ALL file operations.
- Iteration contract: each iteration must either (a) produce new evidence, (b) make one concrete narrowing step, or (c) report partial/final result.

# Workflow

## For research tasks:
1. Search (find_definition/grep_search) → 2. Read files → 3. Analyze → 4. report()

## For edit tasks:
1. Read target file → 2. Plan changes → 3. Edit (fs_replace preferred, fs_patch for large blocks) → 4. Read back to verify → 5. shell_exec to test → 6. report()

## Verification contract (non-trivial edits)
When modifying 3+ files or making API/infrastructure changes:
- Run relevant tests or build after editing
- Check imports resolve in consuming files
- Report what verification you performed

## When stuck:
- Try different search approach, read surrounding files
- If blocked, report partial findings — partial answer beats infinite loop

# Communication
- Write 1-3 sentences of reasoning BEFORE each tool call — explain what and why.
- Match the user's language. Russian → answer in Russian.
- ALWAYS call \`report\` as your final action — no exceptions.`;
}

// ═════════════════════════════════════════════════════════════════════════════
// SEMI-STATIC SECTION — per-session, changes rarely
// ═════════════════════════════════════════════════════════════════════════════

function buildSessionContext(input: SystemPromptInput): string {
  const parts: string[] = [];

  // Working directory
  parts.push(`# Working directory\n\`${input.workingDir}\``);

  // Delegation (only for top-level agents)
  if (!input.isSubAgent) {
    parts.push(`# Delegation
- **task_submit** — start a sub-agent in background. Returns task ID immediately.
- **task_status** — check progress without blocking.
- **task_collect** — wait for task to complete and get result.
For complex multi-part tasks, delegate independent subtasks to run concurrently.`);
  }

  // Project instructions — conditionally loaded, truncated to 4K
  const instructions = loadProjectInstructions(input.workingDir);
  if (instructions) {
    const truncated = instructions.length > MAX_INSTRUCTIONS_CHARS
      ? instructions.slice(0, MAX_INSTRUCTIONS_CHARS) + '\n\n[...truncated — use fs_read to see full file...]'
      : instructions;
    parts.push(`# Project Instructions\n${truncated}`);
  }

  // Session continuity hint
  if (input.sessionId) {
    parts.push('# Session continuity\nUse conversation history as primary context. Do not restate long history from memory when already in messages.');
  }

  return parts.join('\n\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// DYNAMIC SECTION — per-iteration, changes each LLM call
// ═════════════════════════════════════════════════════════════════════════════

async function buildDynamicContext(input: SystemPromptInput): Promise<string | null> {
  const parts: string[] = [];

  // Memory context
  if (input.memory) {
    const memCtx = await getMemoryContext(input.memory);
    if (memCtx.trim()) {
      parts.push(`# Memory Context\n${memCtx}`);
    }
    const taskCtx = await getOriginalTaskContext(input.memory, input.currentTask);
    if (taskCtx) { parts.push(taskCtx); }
  }

  // Fact Sheet (Tier 1: Hot Memory)
  if (input.factSheetContent) {
    parts.push(`# Accumulated Knowledge\n${input.factSheetContent}`);
  }

  // Archive hint (Tier 2: Cold Storage) — one line, not full content
  if (input.archiveSummaryHint) {
    parts.push(input.archiveSummaryHint);
  }

  // Workspace topology — compact format, only if discovered
  const wsPrompt = buildWorkspaceDiscoveryPrompt(input.workspaceDiscovery);
  if (wsPrompt) {
    parts.push(wsPrompt);
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers (unchanged logic, just organized)
// ═════════════════════════════════════════════════════════════════════════════

export function loadProjectInstructions(workingDir: string): string | null {
  for (const fileName of INSTRUCTION_FILE_NAMES) {
    const filePath = path.join(workingDir, fileName);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content.length > 0) { return content; }
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function getMemoryContext(memory: AgentMemory): Promise<string> {
  try {
    if ('getStructuredContext' in memory && typeof memory.getStructuredContext === 'function') {
      const structured = await memory.getStructuredContext(1500);
      if (structured && typeof structured === 'string' && structured.trim().length > 0) {
        return structured;
      }
    }

    if ('getContext' in memory && typeof memory.getContext === 'function') {
      const context = await memory.getContext(2000);
      if (context && typeof context === 'string' && context.trim().length > 0) {
        return context;
      }
    }
  } catch {
    // Memory retrieval errors are non-fatal
  }
  return '';
}

async function getOriginalTaskContext(
  memory: AgentMemory,
  currentTask?: string
): Promise<string | null> {
  try {
    if (!('getContext' in memory) || typeof memory.getContext !== 'function') {
      return null;
    }

    const context = await memory.getContext(2000);
    if (!context || typeof context !== 'string') {
      return null;
    }

    // Check for target directory constraints
    const dirMatch = context.match(/target\s*(?:dir|directory|path)\s*[:=]\s*(.+)/i);
    const requirements = context.match(/requirements?\s*[:=]\s*(.+)/i);

    if (!dirMatch && !requirements) {
      return null;
    }

    let ctx = '\n\n**⚠️ IMPORTANT CONTEXT — Original User Task:**\n';
    if (dirMatch) {
      ctx += `- Target directory: ${dirMatch[1]?.trim()}\n`;
    }
    if (requirements) {
      ctx += `- Requirements: ${requirements[1]?.trim()}\n`;
    }
    if (currentTask) {
      ctx += `- Current subtask: ${currentTask}\n`;
    }

    return ctx;
  } catch {
    return null;
  }
}

function buildWorkspaceDiscoveryPrompt(
  discovery: WorkspaceDiscoveryResult | null | undefined
): string | null {
  if (!discovery?.repos?.length) { return null; }

  // Compact format — just repo names and paths, not full descriptions
  const repos = discovery.repos.slice(0, 24);
  const lines = repos.map(r => {
    const pkgCount = r.packages?.length ?? 0;
    return `  ${r.name}: ${r.path}${pkgCount > 0 ? ` (${pkgCount} packages)` : ''}`;
  });

  return `# Workspace (${repos.length} repos)\n${lines.join('\n')}`;
}
