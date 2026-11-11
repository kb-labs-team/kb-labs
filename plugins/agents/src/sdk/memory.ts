/**
 * AgentMemory — interface for what the agent remembers across iterations.
 *
 * Implementations live in agent-core:
 *   - InMemoryAgentMemory    — simple in-process store
 *   - ArchiveAgentMemory     — persistent file-backed store
 *   - RAGAgentMemory         — vector-search backed (mind-engine)
 */

// ─────────────────────────────────────────────────────────────────────────────
// MemoryEntry
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  content: string;
  type: 'fact' | 'task' | 'observation' | 'error';
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentMemory interface
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentMemory {
  add(entry: MemoryEntry): Promise<void>;
  /** Returns entries relevant to the query (semantic or keyword search) */
  get(query: string): Promise<MemoryEntry[]>;
  clear(): Promise<void>;
}
