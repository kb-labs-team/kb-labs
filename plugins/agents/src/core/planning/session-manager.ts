/**
 * Session manager - handles agent session persistence
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AgentSession, AgentSessionInfo, AgentMode, AgentEvent, Turn, TurnDelta, FileChangeSummary } from '../../contracts/index.js';
import { SessionArtifactStore } from '../../store/index.js';
import { TurnAssembler } from './turn-assembler.js';
import { diffTurn } from './turn-diff.js';

/**
 * Extended session with agentId for storage
 */
interface StoredSession extends AgentSession {
  agentId: string;
  name?: string;
}

/**
 * Conversation turn extracted from events
 */
export interface ConversationTurn {
  userTask: string;
  agentResponse?: string;
  timestamp: string;
}

/**
 * Shared, process-wide state that MUST outlive any single SessionManager
 * instance. Callers (run-handler.ts, CLI commands, generate-spec-handler.ts)
 * each construct their own `new SessionManager(workingDir)` per request/call
 * — there is no one long-lived instance per session. If the session-scoped
 * seq counter or write-ordering queues were plain instance fields, two
 * SessionManager instances processing the SAME session concurrently (e.g.
 * two runs whose persistence windows overlap) would each bootstrap their
 * own counter from a stale snapshot of events.ndjson and could hand out
 * COLLIDING seq values — which the client trusts strictly for ordering and
 * gap detection, so a collision means a real turn update gets silently
 * dropped as an "already seen" duplicate.
 * Stored on globalThis (same pattern as RunManager) so it also survives
 * tsup bundling multiple entry points into separate module scopes that
 * still run in the same Node process.
 */
interface SharedSessionManagerState {
  sessionSeqCounters: Map<string, number>;
  turnSeqCounters: Map<string, number>;
  writeQueues: Map<string, Promise<void>>;
  eventQueues: Map<string, Promise<void>>;
}

const SHARED_STATE_KEY = '__kb_agent_session_manager_shared_state__';

function getSharedState(): SharedSessionManagerState {
  const g = globalThis as Record<string, unknown>;
  if (!g[SHARED_STATE_KEY]) {
    g[SHARED_STATE_KEY] = {
      sessionSeqCounters: new Map<string, number>(),
      turnSeqCounters: new Map<string, number>(),
      writeQueues: new Map<string, Promise<void>>(),
      eventQueues: new Map<string, Promise<void>>(),
    } satisfies SharedSessionManagerState;
  }
  return g[SHARED_STATE_KEY] as SharedSessionManagerState;
}

interface RunTraceArtifacts {
  facts: string[];
  findings: string[];
  decisions: string[];
  assumptions: string[];
  scopeHints: string[];
}

interface SessionTraceArtifacts {
  version: number;
  updatedAt: string;
  byRun: Record<string, RunTraceArtifacts>;
  merged: RunTraceArtifacts;
}

export interface SessionKpiBaseline {
  version: number;
  updatedAt: string;
  driftRateEma: number;
  evidenceDensityEma: number;
  toolErrorRateEma: number;
  samples: number;
  tokenHistory: number[];
  iterationUtilizationHistory: number[];
  qualityScoreHistory: number[];
}

/**
 * Manages agent sessions (creation, persistence, retrieval)
 */
export class SessionManager {
  private workingDir: string;
  private readonly artifactStore: SessionArtifactStore;

  /**
   * In-memory cache of the per-session monotonic event sequence counter
   * (initialized lazily from NDJSON line count). Backed by shared
   * process-wide state — see SharedSessionManagerState's doc comment for
   * why this must NOT be a plain instance field.
   */
  private get sessionSeqCounters(): Map<string, number> { return getSharedState().sessionSeqCounters; }
  /** In-memory cache of turn sequence counters per session (for turns.json). Shared — see sessionSeqCounters. */
  private get turnSeqCounters(): Map<string, number> { return getSharedState().turnSeqCounters; }

  /** Turn assembler for creating turn snapshots from events */
  private assembler = new TurnAssembler();

  /** Write queue per session to prevent concurrent write race conditions. Shared — see sessionSeqCounters. */
  private get writeQueues(): Map<string, Promise<void>> { return getSharedState().writeQueues; }

  /**
   * Serialized event-processing queue per session.
   * Ensures addEvent calls for the same session are processed in arrival order
   * even when the caller fires them concurrently with void (fire-and-forget).
   * This prevents tool:end being processed by TurnAssembler before tool:start.
   * Shared — see sessionSeqCounters.
   */
  private get eventQueues(): Map<string, Promise<void>> { return getSharedState().eventQueues; }
  /** Write queue per session for artifact projection updates */
  private artifactWriteQueues = new Map<string, Promise<void>>();
  /** Write queue per session for KPI baseline updates */
  private kpiWriteQueues = new Map<string, Promise<void>>();

  constructor(workingDir: string) {
    this.workingDir = workingDir;
    this.artifactStore = new SessionArtifactStore(workingDir);
  }

  /**
   * Create a new session
   */
  async createSession(config: {
    mode: AgentMode;
    task: string;
    agentId: string;
    name?: string;
    planId?: string;
    sessionId?: string;
  }): Promise<AgentSessionInfo> {
    const sessionId = config.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();

    const session: StoredSession = {
      id: sessionId,
      mode: config.mode,
      task: config.task,
      agentId: config.agentId,
      name: config.name || this.generateSessionName(config.task),
      planId: config.planId,
      workingDir: this.workingDir,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };

    await this.saveSession(session);

    return this.toSessionInfo(session, 0, undefined, now);
  }

  /**
   * Generate a human-readable session name from task
   */
  private generateSessionName(task: string): string {
    // Take first 50 chars, cut at word boundary
    const maxLen = 50;
    if (task.length <= maxLen) {return task;}
    const cut = task.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    return lastSpace > 20 ? cut.slice(0, lastSpace) + '...' : cut + '...';
  }

  /**
   * Convert stored session to session info
   */
  private toSessionInfo(
    session: StoredSession,
    runCount: number,
    lastMessage: string | undefined,
    lastActivityAt: string
  ): AgentSessionInfo {
    return {
      ...session,
      agentId: session.agentId,
      name: session.name,
      runCount,
      lastMessage,
      lastActivityAt,
    };
  }

  /**
   * Save session to disk
   */
  async saveSession(session: StoredSession | AgentSession): Promise<void> {
    const sessionDir = this.getSessionDir(session.id);
    await fs.mkdir(sessionDir, { recursive: true });

    const sessionFile = path.join(sessionDir, 'session.json');
    await fs.writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf-8');
    await this.artifactStore.saveSessionMetadata(session as AgentSession & Record<string, unknown>);
  }

  /**
   * Load session from disk
   */
  async loadSession(sessionId: string): Promise<StoredSession | null> {
    try {
      const sessionFile = path.join(this.getSessionDir(sessionId), 'session.json');
      const content = await fs.readFile(sessionFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Get session with full info
   */
  async getSessionInfo(sessionId: string): Promise<AgentSessionInfo | null> {
    const session = await this.loadSession(sessionId);
    if (!session) {return null;}

    const events = await this.getSessionEvents(sessionId);
    const runCount = events.filter((e) => e.type === 'agent:start').length;
    const lastLlmEvent = [...events].reverse().find((e) => e.type === 'llm:end');
    const lastMessage = lastLlmEvent?.data?.content as string | undefined;
    const lastEvent = events[events.length - 1];
    const lastActivityAt = lastEvent
      ? new Date(lastEvent.timestamp).toISOString()
      : session.updatedAt;

    return this.toSessionInfo(session, runCount, lastMessage?.slice(0, 100), lastActivityAt);
  }

  /**
   * Update session status
   */
  async updateSessionStatus(
    sessionId: string,
    status: AgentSession['status']
  ): Promise<void> {
    const session = await this.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = status;
    session.updatedAt = new Date().toISOString();

    await this.saveSession(session);
  }

  /**
   * List all sessions with info
   */
  async listSessions(options?: {
    agentId?: string;
    status?: AgentSession['status'];
    limit?: number;
    offset?: number;
  }): Promise<{ sessions: AgentSessionInfo[]; total: number }> {
    const sessionsRoot = path.join(this.workingDir, '.kb', 'agents', 'sessions');

    try {
      const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
      const sessionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

      // Load session info in parallel for better performance
      const sessionInfos = await Promise.all(
        sessionDirs.map((sessionId) => this.getSessionInfo(sessionId))
      );

      // Filter out null results and apply user filters
      let sessions: AgentSessionInfo[] = sessionInfos
        .filter((info): info is AgentSessionInfo => {
          if (!info) {
            return false;
          }
          // Apply filters
          if (options?.agentId && info.agentId !== options.agentId) {
            return false;
          }
          if (options?.status && info.status !== options.status) {
            return false;
          }
          return true;
        });

      // Sort by last activity (newest first)
      sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

      const total = sessions.length;

      // Apply pagination
      if (options?.offset) {
        sessions = sessions.slice(options.offset);
      }
      if (options?.limit) {
        sessions = sessions.slice(0, options.limit);
      }

      return { sessions, total };
    } catch {
      return { sessions: [], total: 0 };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Storage (NDJSON format - append-safe)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get the next seq for a session — monotonic across the WHOLE session
   * (every run, every turn), not scoped to a single run. This is the one
   * cursor the WS protocol and REST resume/gap-recovery paths rely on;
   * it must be a single, ever-increasing number per session for "seq > N"
   * comparisons to mean anything.
   *
   * Lazily initialized from the NDJSON LINE COUNT, not the max embedded
   * `sessionSeq` value. Old sessions were written under the previous
   * per-run scheme, where two different runs both start their own
   * `sessionSeq` at 1 — so the max embedded value can be far smaller than
   * the true number of events and would hand out colliding seq numbers
   * for old sessions. Line count is always >= any embedded per-run value
   * and is exactly equal to it for sessions already written under this
   * per-session scheme, so it's a safe bootstrap either way.
   */
  private async ensureSessionSeqBootstrapped(sessionId: string): Promise<void> {
    if (this.sessionSeqCounters.has(sessionId)) { return; }
    let lineCount = 0;
    try {
      const content = await fs.readFile(this.getEventsPath(sessionId), 'utf-8');
      lineCount = content.split('\n').filter((l) => l.trim()).length;
    } catch {
      // File doesn't exist yet - start from 0
    }
    this.sessionSeqCounters.set(sessionId, lineCount);
  }

  private async getNextSessionSeq(sessionId: string): Promise<number> {
    await this.ensureSessionSeqBootstrapped(sessionId);
    const next = this.sessionSeqCounters.get(sessionId)! + 1;
    this.sessionSeqCounters.set(sessionId, next);
    return next;
  }

  /**
   * Current session-wide cursor value WITHOUT advancing it. Used for the
   * cold-start snapshot and gap-recovery projection, both of which need to
   * hand the client a `seq` to resume from without consuming one.
   */
  async getCurrentSessionSeq(sessionId: string): Promise<number> {
    await this.ensureSessionSeqBootstrapped(sessionId);
    return this.sessionSeqCounters.get(sessionId)!;
  }

  /**
   * Add event to session (append-only, race-condition safe).
   * Assigns the session-wide monotonic sessionSeq.
   * Also processes the event to update turn snapshots, returning whatever
   * TurnDelta[] that produced (empty if the event didn't touch a turn) so
   * callers can broadcast them once persistence is confirmed.
   *
   * Events for the same session are serialized via eventQueues so that
   * concurrent fire-and-forget callers (void addEvent(...)) don't cause
   * tool:end to be processed before tool:start in TurnAssembler.
   */
  async addEvent(sessionId: string, event: AgentEvent): Promise<TurnDelta[]> {
    const prev = this.eventQueues.get(sessionId) ?? Promise.resolve();
    // Chain this event after prev, but store a "silenced" tail that always resolves
    // (never rejects and holds no references to prior chain links after completion).
    // This prevents unbounded promise chain growth which causes OOM on long runs.
    const next = prev.then(() => this._addEventInternal(sessionId, event));
    const tail = next.then(() => {}, () => {});
    this.eventQueues.set(sessionId, tail);
    return next;
  }

  private async _addEventInternal(sessionId: string, event: AgentEvent): Promise<TurnDelta[]> {
    const sessionDir = this.getSessionDir(sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    await this.artifactStore.ensureSessionArtifacts(sessionId);

    const sessionSeq = await this.getNextSessionSeq(sessionId);
    const line = JSON.stringify({ ...event, sessionSeq }) + '\n';
    await fs.appendFile(this.getEventsPath(sessionId), line, 'utf-8');
    await fs.appendFile(this.artifactStore.getArtifactPath(sessionId, 'trace.ndjson'), line, 'utf-8');

    // Process event and update turn snapshot
    const result = await this.processEventAndUpdateTurn(sessionId, { ...event, sessionSeq });
    return result?.deltas ?? [];
  }

  /**
   * Get all events for a session
   */
  async getSessionEvents(
    sessionId: string,
    options?: { limit?: number; offset?: number; types?: string[] }
  ): Promise<AgentEvent[]> {
    const eventsFile = this.getEventsPath(sessionId);

    try {
      const content = await fs.readFile(eventsFile, 'utf-8');

      // Parse NDJSON (one JSON object per line)
      let events: AgentEvent[] = content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((e): e is AgentEvent => e !== null);

      // Filter by types
      if (options?.types?.length) {
        events = events.filter((e) => options.types!.includes(e.type));
      }

      // Apply pagination
      if (options?.offset) {
        events = events.slice(options.offset);
      }
      if (options?.limit) {
        events = events.slice(0, options.limit);
      }

      return events;
    } catch {
      return [];
    }
  }

  /**
   * Count events in session
   */
  async countEvents(sessionId: string, types?: string[]): Promise<number> {
    const events = await this.getSessionEvents(sessionId, { types });
    return events.length;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Conversation History (extracted from events)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract conversation history from session events
   *
   * Parses events.ndjson to reconstruct user-agent conversation turns.
   * Uses agent:start events (without parentAgentId = top-level requests).
   * Uses agent:end for summaries.
   *
   * @param sessionId - Session ID
   * @param maxTurns - Maximum number of turns to return (default: 10)
   * @returns Array of conversation turns, oldest first
   */
  async getConversationHistory(
    sessionId: string,
    maxTurns = 10
  ): Promise<Array<{ userTask: string; agentResponse?: string; timestamp: string }>> {
    // Prefer canonical turn snapshots first.
    const fromTurns = await this.getConversationHistoryFromTurns(sessionId, maxTurns);
    if (fromTurns.length > 0) {
      return fromTurns;
    }

    // Fallback for legacy sessions without turns.
    const events = await this.getSessionEvents(sessionId);
    if (events.length === 0) {
      return [];
    }

    const turns: Array<{ userTask: string; agentResponse?: string; timestamp: string }> = [];
    let currentTurn: { userTask: string; agentResponse?: string; timestamp: string } | null = null;

    for (const event of events) {
      // Use agent:start without parentAgentId (top-level agent, not sub-agents)
      if (event.type === 'agent:start' && !event.parentAgentId) {
        // Save previous turn if exists
        if (currentTurn) {
          turns.push(currentTurn);
        }
        currentTurn = {
          userTask: (event.data as { task: string }).task,
          timestamp: event.timestamp,
        };
      }

      // Agent end - capture summary as response
      if (event.type === 'agent:end' && !event.parentAgentId && currentTurn) {
        const summary = (event.data as { summary: string }).summary;
        // Smart truncation: preserve beginning (context) and end (conclusions)
        if (summary.length > 2000) {
          const head = summary.slice(0, 1200);
          const tail = summary.slice(-700);
          currentTurn.agentResponse = `${head}\n\n[...${summary.length - 1900} chars omitted...]\n\n${tail}`;
        } else {
          currentTurn.agentResponse = summary;
        }
      }
    }

    // Don't forget the last turn
    if (currentTurn) {
      turns.push(currentTurn);
    }

    // Return last N turns (excluding current one which will be added by caller)
    // Skip the last turn if it doesn't have a response yet (current run)
    const completedTurns = turns.filter(t => t.agentResponse);
    return completedTurns.slice(-maxTurns);
  }

  /**
   * Build conversation history from canonical turn snapshots (turns.json).
   * This avoids lossy reconstruction from events summary.
   */
  private async getConversationHistoryFromTurns(
    sessionId: string,
    maxTurns: number
  ): Promise<ConversationTurn[]> {
    const turns = await this.getTurns(sessionId);
    if (turns.length === 0) {
      return [];
    }

    const sorted = [...turns].sort((a, b) => a.sequence - b.sequence);
    const conversation: ConversationTurn[] = [];
    const pendingUsers: Array<{ task: string; timestamp: string }> = [];

    for (const turn of sorted) {
      if (turn.type === 'user') {
        const userMessage = turn.steps.find((step) => step.type === 'text' && step.role === 'user');
        const task = (userMessage as { content?: string } | undefined)?.content?.trim();
        if (task) {
          pendingUsers.push({ task, timestamp: turn.startedAt });
        }
        continue;
      }

      if (turn.type !== 'assistant') {
        continue;
      }

      const assistantText = this.extractAssistantText(turn);
      if (!assistantText) {
        continue;
      }

      const pairedUser = pendingUsers.shift();
      conversation.push({
        userTask: pairedUser?.task || turn.metadata?.taskId || 'Follow-up request',
        agentResponse: assistantText,
        timestamp: pairedUser?.timestamp || turn.startedAt,
      });
    }

    return conversation.slice(-maxTurns);
  }

  private extractAssistantText(turn: Turn): string | undefined {
    const textSteps = turn.steps.filter(
      (step): step is Extract<Turn['steps'][number], { type: 'text' }> =>
        step.type === 'text' && step.role === 'assistant'
    );

    if (textSteps.length === 0) {
      return undefined;
    }

    const content = textSteps.map((step) => step.content?.trim()).filter(Boolean).join('\n\n');
    if (!content) {
      return undefined;
    }

    if (content.length > 3000) {
      const head = content.slice(0, 1800);
      const tail = content.slice(-900);
      return `${head}\n\n[...${content.length - 2700} chars omitted...]\n\n${tail}`;
    }
    return content;
  }

  /**
   * Get conversation history with progressive summarization for long sessions
   *
   * Strategy:
   * - Recent turns (last 3): Full context (up to 2000 chars each)
   * - Mid-term turns (4-10): Summarized (up to 500 chars each)
   * - Old turns (11+): Ultra-brief (up to 150 chars each, max 10 oldest)
   *
   * This keeps token usage bounded while maintaining context depth.
   *
   * @param sessionId - Session ID
   * @param llm - Optional LLM instance for intelligent summarization (if not provided, uses truncation)
   * @returns Structured history with recent/mid-term/old tiers
   */
  async getConversationHistoryWithSummarization(
    sessionId: string,
    llm?: { chat?: (messages: Array<{ role: string; content: string }>) => Promise<string> }
  ): Promise<{
    recent: ConversationTurn[]; // last 3, full detail
    midTerm: ConversationTurn[]; // 4-10, summarized
    old: ConversationTurn[]; // 11+, ultra-brief
  }> {
    const allTurns = await this.getConversationHistory(sessionId, 100); // Get up to 100 turns

    if (allTurns.length === 0) {
      return { recent: [], midTerm: [], old: [] };
    }

    // Split into tiers (most recent first after reverse)
    const reversed = [...allTurns].reverse(); // Newest first
    const recent = reversed.slice(0, 3).reverse(); // Last 3, restore chronological order
    const midTermRaw = reversed.slice(3, 10).reverse(); // Turns 4-10
    const oldRaw = reversed.slice(10, 20).reverse(); // Turns 11-20 (max 10)

    // Recent: keep as-is (already truncated to 2000 in getConversationHistory)
    // Mid-term: summarize to 500 chars
    const midTerm: ConversationTurn[] = [];
    for (const turn of midTermRaw) {
      const response = turn.agentResponse || '';
      let summarized = response;

      if (response.length > 500) {
        if (llm?.chat) {
          // LLM-based intelligent summarization
          try {
            summarized = await llm.chat([
              {
                role: 'system',
                content:
                  'Summarize the following agent response in 2-3 sentences (max 500 chars). Keep key facts, file paths, and decisions.',
              },
              { role: 'user', content: response },
            ]);
            // Enforce hard limit
            if (summarized.length > 500) {
              summarized = summarized.slice(0, 497) + '...';
            }
          } catch {
            // Fallback to truncation
            summarized = response.slice(0, 497) + '...';
          }
        } else {
          // Simple truncation with head+tail
          const head = response.slice(0, 300);
          const tail = response.slice(-150);
          summarized = `${head}...[omitted]...${tail}`;
        }
      }

      midTerm.push({
        userTask: turn.userTask,
        agentResponse: summarized,
        timestamp: turn.timestamp,
      });
    }

    // Old: ultra-brief (150 chars max)
    const old: ConversationTurn[] = [];
    for (const turn of oldRaw) {
      const response = turn.agentResponse || '';
      let brief = response;

      if (response.length > 150) {
        if (llm?.chat) {
          // LLM-based ultra-brief summary
          try {
            brief = await llm.chat([
              {
                role: 'system',
                content: 'Summarize in ONE sentence (max 150 chars). Only the most critical point.',
              },
              { role: 'user', content: response },
            ]);
            if (brief.length > 150) {
              brief = brief.slice(0, 147) + '...';
            }
          } catch {
            // Fallback to simple truncation
            brief = response.slice(0, 147) + '...';
          }
        } else {
          // Extract first sentence or truncate
          const firstSentence = response.split(/[.!?]\s/)[0];
          brief = firstSentence && firstSentence.length > 150
            ? firstSentence.slice(0, 147) + '...'
            : firstSentence || response.slice(0, 147) + '...';
        }
      }

      old.push({
        userTask: turn.userTask,
        agentResponse: brief,
        timestamp: turn.timestamp,
      });
    }

    return { recent, midTerm, old };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Turn Snapshots (NEW - Phase 1: Backend Turn Assembly)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Store turn snapshot to turns.json
   * Serializes writes per session to prevent race-condition duplicates
   */
  async storeTurnSnapshot(sessionId: string, turn: Turn): Promise<void> {
    // Chain writes for same session so concurrent calls don't race
    const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this._writeTurnSnapshot(sessionId, turn));
    this.writeQueues.set(sessionId, next.catch(() => {})); // swallow to keep chain alive
    return next;
  }

  private async _writeTurnSnapshot(sessionId: string, turn: Turn): Promise<void> {
    const turnsPath = this.getTurnsPath(sessionId);
    const sessionDir = this.getSessionDir(sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    let turns: Turn[] = [];
    try {
      const content = await fs.readFile(turnsPath, 'utf-8');
      turns = JSON.parse(content);
    } catch {
      // File doesn't exist yet - start fresh
    }

    // Update or append turn
    const index = turns.findIndex((t) => t.id === turn.id);
    if (index >= 0) {
      turns[index] = turn;
    } else {
      turns.push(turn);
    }

    await fs.writeFile(turnsPath, JSON.stringify(turns, null, 2), 'utf-8');
  }

  /**
   * Attach file change summaries to the assistant turn for a given runId.
   * Called after agent.execute() completes to surface file changes in the UI.
   */
  async attachFileChangesToTurn(
    sessionId: string,
    runId: string,
    fileChanges: FileChangeSummary[]
  ): Promise<void> {
    const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this._attachFileChangesToTurn(sessionId, runId, fileChanges));
    this.writeQueues.set(sessionId, next.catch(() => {}));
    return next;
  }

  private async _attachFileChangesToTurn(
    sessionId: string,
    runId: string,
    fileChanges: FileChangeSummary[]
  ): Promise<void> {
    const turnsPath = this.getTurnsPath(sessionId);

    let turns: Turn[] = [];
    try {
      const content = await fs.readFile(turnsPath, 'utf-8');
      turns = JSON.parse(content);
    } catch {
      return; // No turns file yet
    }

    // Find the assistant turn for this runId
    const turnIndex = turns.findIndex(
      (t) => t.type === 'assistant' && t.metadata?.runId === runId
    );
    if (turnIndex < 0) {
      return; // Turn not found — may happen if run was never persisted
    }

    turns[turnIndex]!.metadata.fileChanges = fileChanges;
    await fs.writeFile(turnsPath, JSON.stringify(turns, null, 2), 'utf-8');
  }

  /**
   * Update fileChanges metadata on a turn (e.g. after approve/rollback).
   * Patches individual change entries by changeId.
   */
  async updateTurnFileChanges(
    sessionId: string,
    runId: string,
    updatedChanges: import('../../contracts/index.js').FileChangeSummary[]
  ): Promise<void> {
    const turnsPath = this.getTurnsPath(sessionId);
    let turns: Turn[] = [];
    try {
      const content = await fs.readFile(turnsPath, 'utf-8');
      turns = JSON.parse(content);
    } catch {
      return;
    }

    const turnIndex = turns.findIndex(
      (t) => t.type === 'assistant' && t.metadata?.runId === runId
    );
    if (turnIndex < 0) {return;}

    const existing = turns[turnIndex]!.metadata.fileChanges ?? [];
    const patchMap = new Map(updatedChanges.map((c) => [c.changeId, c]));
    turns[turnIndex]!.metadata.fileChanges = existing.map((c) =>
      patchMap.has(c.changeId) ? { ...c, ...patchMap.get(c.changeId) } : c
    );
    await fs.writeFile(turnsPath, JSON.stringify(turns, null, 2), 'utf-8');
  }

  /**
   * Load turn snapshots for session
   */
  async getTurns(sessionId: string): Promise<Turn[]> {
    const turnsPath = this.getTurnsPath(sessionId);

    try {
      const content = await fs.readFile(turnsPath, 'utf-8');
      const raw: Turn[] = JSON.parse(content);
      // Deduplicate by id (guard against race-condition duplicates in existing files)
      const seen = new Set<string>();
      return raw.filter((t) => {
        if (seen.has(t.id)) {return false;}
        seen.add(t.id);
        return true;
      });
    } catch {
      // File doesn't exist - try lazy migration from events
      return this.migrateTurnsFromEvents(sessionId);
    }
  }

  /**
   * Lazy migration: rebuild turns from events.ndjson
   * (for old sessions without turns.json)
   */
  private async migrateTurnsFromEvents(sessionId: string): Promise<Turn[]> {
    console.log(`[SessionManager] Migrating session ${sessionId} to turn format...`);

    const events = await this.getSessionEvents(sessionId);
    if (events.length === 0) {
      return [];
    }

    const assembler = new TurnAssembler();
    const completedTurns: Turn[] = [];

    for (const event of events) {
      const turn = assembler.processEvent(event);
      if (turn && turn.status === 'completed') {
        completedTurns.push(turn);
      }
    }

    // Add any active turns
    const activeTurns = assembler.getActiveTurns();
    const allTurns = [...completedTurns, ...activeTurns];

    // Cache for future use
    if (allTurns.length > 0) {
      const turnsPath = this.getTurnsPath(sessionId);
      await fs.writeFile(turnsPath, JSON.stringify(allTurns, null, 2), 'utf-8');
    }

    return allTurns;
  }

  /**
   * Get conversation snapshot for WebSocket connections
   * Returns last 20 completed turns + active turns
   */
  async getConversationSnapshot(sessionId: string): Promise<{
    completedTurns: Turn[];
    activeTurns: Turn[];
    totalTurns: number;
  }> {
    const turns = await this.getTurns(sessionId);
    const activeTurns = turns.filter((t) => t.status === 'streaming');

    // Keep last 20 completed turns for history
    const completedTurns = turns
      .filter((t) => t.status === 'completed' || t.status === 'failed')
      .slice(-20);

    return {
      completedTurns,
      activeTurns,
      totalTurns: turns.length,
    };
  }

  /**
   * Create user turn with task/question
   * Called when user submits a task to agent
   */
  async createUserTurn(sessionId: string, task: string, runId: string, clientId?: string): Promise<Turn> {
    const sequence = await this.reserveNextTurnSequence(sessionId);
    const timestamp = new Date().toISOString();

    const userTurn: Turn = {
      id: `turn-${runId}-user`,
      type: 'user',
      sequence,
      startedAt: timestamp,
      completedAt: timestamp, // User turn is immediately complete
      status: 'completed',
      steps: [
        {
          type: 'text',
          id: `step-1`,
          timestamp,
          content: task,
          role: 'user',
        },
      ],
      metadata: {
        agentId: 'user',
        ...(clientId ? { clientId } : {}),
      },
    };

    await this.storeTurnSnapshot(sessionId, userTurn);
    return userTurn;
  }

  /**
   * Reserve next turn sequence number atomically per session.
   * Uses the same serialized write queue as turns.json updates.
   */
  private async reserveNextTurnSequence(sessionId: string): Promise<number> {
    let reserved = 1;
    const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (!this.turnSeqCounters.has(sessionId)) {
        const turns = await this.getTurns(sessionId);
        const maxSequence = turns.length === 0 ? 0 : Math.max(...turns.map((t) => t.sequence));
        this.turnSeqCounters.set(sessionId, maxSequence);
      }
      reserved = (this.turnSeqCounters.get(sessionId) ?? 0) + 1;
      this.turnSeqCounters.set(sessionId, reserved);
    });
    this.writeQueues.set(sessionId, next.catch(() => {}));
    await next;
    return reserved;
  }

  /**
   * Process event, update the turn projection, and compute the deltas this
   * mutation produced (relative to the turn's state just before this
   * event). Returns null when the event didn't touch any turn, or touched
   * one without producing any externally-observable change.
   *
   * The "before" snapshot is captured from the assembler's live (in-place
   * mutated) turn reference BEFORE processEventAsync runs — the assembler
   * mutates the same object, so this is the only point at which a
   * pre-mutation snapshot is available.
   *
   * Deliberately resolves the CURRENT turn via peekTurn rather than trusting
   * processEventAsync's own return value: the assembler treats "just
   * created, no steps yet" (a bare agent:start with nothing else to report)
   * as "not updated" and returns null for it — but the turn WAS created as
   * a side effect (added to activeTurns), which is itself diff-worthy: it's
   * the only point `turn:created` can ever fire from. Without this, the
   * turn is silently created in memory but never persisted or broadcast,
   * and every later event sees `before !== null` (peekTurn already finds
   * it), so `turn:created` never fires at all.
   */
  async processEventAndUpdateTurn(
    sessionId: string,
    event: AgentEvent,
  ): Promise<{ turn: Turn; deltas: TurnDelta[] } | null> {
    const turnId = this.assembler.getTurnIdForEvent(event);
    if (!turnId) { return null; }

    const liveBefore = this.assembler.peekTurn(turnId);
    const before: Turn | null = liveBefore ? structuredClone(liveBefore) : null;

    const returnedTurn = await this.assembler.processEventAsync(event, async (sid) => {
      return this.reserveNextTurnSequence(sid);
    });
    const turn = returnedTurn ?? this.assembler.peekTurn(turnId);
    if (!turn) { return null; }

    // Stamp runId once, at turn creation (before === null), so it's already
    // part of the turn:created delta's embedded turn rather than showing up
    // as a separate turn:metadata patch on whatever event happens next.
    if (event.runId && turn.type === 'assistant' && !turn.metadata.runId) {
      turn.metadata.runId = event.runId;
    }

    const seq = event.sessionSeq ?? await this.getCurrentSessionSeq(sessionId);
    const deltas = diffTurn(before, turn, seq);
    if (deltas.length === 0) { return null; }

    await this.storeTurnSnapshot(sessionId, turn);
    return { turn, deltas };
  }

  /**
   * Current projection of a session: its full turn list plus the seq cursor
   * it reflects. Used for the cold-start snapshot AND as the gap-recovery
   * resume payload (see ADR note in the sync design doc) — both send the
   * same shape, just at different points in the connection lifecycle.
   */
  async getProjection(sessionId: string): Promise<{ turns: Turn[]; seq: number }> {
    const [turns, seq] = await Promise.all([
      this.getTurns(sessionId),
      this.getCurrentSessionSeq(sessionId),
    ]);
    return { turns, seq };
  }

  /**
   * Store extracted trace artifacts for a completed run.
   */
  async storeTraceArtifacts(sessionId: string, runId: string, traceEntries: Array<Record<string, unknown>>): Promise<void> {
    if (!runId || traceEntries.length === 0) {
      return;
    }

    await this.updateArtifacts(sessionId, (state) => {
      const extracted = this.extractTraceArtifacts(traceEntries);
      if (
        extracted.facts.length === 0 &&
        extracted.findings.length === 0 &&
        extracted.decisions.length === 0 &&
        extracted.assumptions.length === 0 &&
        extracted.scopeHints.length === 0
      ) {
        return state;
      }

      const existing = state.byRun[runId] || this.createEmptyArtifacts();
      state.byRun[runId] = this.mergeArtifacts(existing, extracted);
      state.merged = this.mergeArtifacts(state.merged, extracted);
      state.updatedAt = new Date().toISOString();
      return state;
    });
  }

  /**
   * Render compact trace-memory context for prompt injection.
   */
  async getTraceArtifactsContext(sessionId: string): Promise<string> {
    const state = await this.loadArtifacts(sessionId);
    const merged = state.merged;

    const lines: string[] = [];
    const facts = merged.facts.slice(-5);
    const findings = merged.findings.slice(-5);
    const decisions = merged.decisions.slice(-5);
    const scopeHints = merged.scopeHints.slice(-5);

    if (facts.length > 0) {
      lines.push('Facts from trace memory:');
      for (const fact of facts) {lines.push(`- ${fact}`);}
    }
    if (findings.length > 0) {
      lines.push('Key findings from trace memory:');
      for (const finding of findings) {lines.push(`- ${finding}`);}
    }
    if (decisions.length > 0) {
      lines.push('Recent reasoning decisions:');
      for (const decision of decisions) {lines.push(`- ${decision}`);}
    }
    if (scopeHints.length > 0) {
      lines.push('Scope hints (paths used before):');
      for (const hint of scopeHints) {lines.push(`- ${hint}`);}
    }

    if (lines.length === 0) {
      return '';
    }

    return `# Trace Memory Artifacts\n${lines.join('\n')}\n`;
  }

  private async loadArtifacts(sessionId: string): Promise<SessionTraceArtifacts> {
    const artifactsPath = this.getArtifactsPath(sessionId);
    try {
      const raw = JSON.parse(await fs.readFile(artifactsPath, 'utf-8')) as SessionTraceArtifacts;
      return {
        version: raw.version || 1,
        updatedAt: raw.updatedAt || new Date().toISOString(),
        byRun: raw.byRun || {},
        merged: raw.merged || this.createEmptyArtifacts(),
      };
    } catch {
      return {
        version: 1,
        updatedAt: new Date().toISOString(),
        byRun: {},
        merged: this.createEmptyArtifacts(),
      };
    }
  }

  private async updateArtifacts(
    sessionId: string,
    updater: (state: SessionTraceArtifacts) => SessionTraceArtifacts
  ): Promise<void> {
    const prev = this.artifactWriteQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const state = await this.loadArtifacts(sessionId);
      const updated = updater(state);
      const sessionDir = this.getSessionDir(sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(this.getArtifactsPath(sessionId), JSON.stringify(updated, null, 2), 'utf-8');
    });
    this.artifactWriteQueues.set(sessionId, next.catch(() => {}));
    await next;
  }

  private extractTraceArtifacts(entries: Array<Record<string, unknown>>): RunTraceArtifacts {
    const artifacts = this.createEmptyArtifacts();

    for (const entry of entries) {
      const type = typeof entry.type === 'string' ? entry.type : '';

      if (type === 'memory:snapshot') {
        const sharedMemory = (entry.sharedMemory as Record<string, unknown> | undefined) || {};
        const facts = Array.isArray(sharedMemory.facts) ? sharedMemory.facts : [];
        const findings = Array.isArray(sharedMemory.findings) ? sharedMemory.findings : [];
        for (const fact of facts) {
          if (typeof fact === 'string') {artifacts.facts.push(fact);}
        }
        for (const finding of findings) {
          if (typeof finding === 'string') {artifacts.findings.push(finding);}
        }
      }

      if (type === 'stopping:analysis') {
        const reasoning = typeof entry.reasoning === 'string' ? entry.reasoning.trim() : '';
        if (reasoning) {artifacts.decisions.push(reasoning);}
      }

      if (type === 'context:trim') {
        const strategy = typeof entry.strategy === 'string' ? entry.strategy : 'unknown';
        artifacts.decisions.push(`Context trimmed (${strategy})`);
      }

      if (type === 'tool:execution') {
        const tool = (entry.tool as Record<string, unknown> | undefined) || {};
        const input = (entry.input as Record<string, unknown> | undefined) || {};
        const toolName = typeof tool.name === 'string' ? tool.name : '';
        const pathLike = input.path;
        const directoryLike = input.directory;

        if (toolName) {
          artifacts.assumptions.push(`Used tool: ${toolName}`);
        }
        if (typeof pathLike === 'string' && pathLike.trim()) {
          artifacts.scopeHints.push(pathLike.trim());
        }
        if (typeof directoryLike === 'string' && directoryLike.trim()) {
          artifacts.scopeHints.push(directoryLike.trim());
        }
      }
    }

    return {
      facts: this.uniqueTail(artifacts.facts, 30),
      findings: this.uniqueTail(artifacts.findings, 30),
      decisions: this.uniqueTail(artifacts.decisions, 30),
      assumptions: this.uniqueTail(artifacts.assumptions, 30),
      scopeHints: this.uniqueTail(artifacts.scopeHints, 30),
    };
  }

  private mergeArtifacts(a: RunTraceArtifacts, b: RunTraceArtifacts): RunTraceArtifacts {
    return {
      facts: this.uniqueTail([...a.facts, ...b.facts], 30),
      findings: this.uniqueTail([...a.findings, ...b.findings], 30),
      decisions: this.uniqueTail([...a.decisions, ...b.decisions], 30),
      assumptions: this.uniqueTail([...a.assumptions, ...b.assumptions], 30),
      scopeHints: this.uniqueTail([...a.scopeHints, ...b.scopeHints], 30),
    };
  }

  private uniqueTail(items: string[], max: number): string[] {
    const seen = new Set<string>();
    const unique = items
      .map((item) => item.trim())
      .filter(Boolean)
      .reverse()
      .filter((item) => {
        if (seen.has(item)) {return false;}
        seen.add(item);
        return true;
      })
      .reverse();
    return unique.slice(-max);
  }

  private createEmptyArtifacts(): RunTraceArtifacts {
    return {
      facts: [],
      findings: [],
      decisions: [],
      assumptions: [],
      scopeHints: [],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Path Helpers
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get session directory path
   */
  getSessionDir(sessionId: string): string {
    return path.join(this.workingDir, '.kb', 'agents', 'sessions', sessionId);
  }

  /**
   * Get events file path (NDJSON format)
   */
  getEventsPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'events.ndjson');
  }

  /**
   * Get session plan file path
   */
  getSessionPlanPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'plan.json');
  }

  /**
   * Get session spec JSON file path
   */
  getSessionSpecPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'spec.json');
  }

  /**
   * Get session spec markdown file path
   */
  getSessionSpecMdPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'spec.md');
  }

  /**
   * Get session progress file path
   */
  getSessionProgressPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'progress.json');
  }

  /**
   * Get turns file path (Turn snapshots JSON)
   */
  getTurnsPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'turns.json');
  }

  /**
   * Get trace artifacts projection path
   */
  getArtifactsPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'trace-artifacts.json');
  }

  /**
   * Get KPI baseline projection path
   */
  getKpiBaselinePath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'kpi-baseline.json');
  }

  /**
   * Read persisted KPI baseline for this session.
   */
  async getKpiBaseline(sessionId: string): Promise<SessionKpiBaseline | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.getKpiBaselinePath(sessionId), 'utf-8')) as Partial<SessionKpiBaseline>;
      if (
        typeof raw.driftRateEma !== 'number'
        || typeof raw.evidenceDensityEma !== 'number'
        || typeof raw.toolErrorRateEma !== 'number'
        || typeof raw.samples !== 'number'
      ) {
        return null;
      }

      return {
        version: raw.version || 1,
        updatedAt: raw.updatedAt || new Date().toISOString(),
        driftRateEma: raw.driftRateEma,
        evidenceDensityEma: raw.evidenceDensityEma,
        toolErrorRateEma: raw.toolErrorRateEma,
        samples: raw.samples,
        tokenHistory: Array.isArray(raw.tokenHistory)
          ? raw.tokenHistory.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).slice(-50)
          : [],
        iterationUtilizationHistory: Array.isArray(raw.iterationUtilizationHistory)
          ? raw.iterationUtilizationHistory.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).slice(-50)
          : [],
        qualityScoreHistory: Array.isArray(raw.qualityScoreHistory)
          ? raw.qualityScoreHistory.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).slice(-50)
          : [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Update persisted KPI baseline with serialized writes per session.
   */
  async updateKpiBaseline(
    sessionId: string,
    updater: (current: SessionKpiBaseline | null) => SessionKpiBaseline
  ): Promise<void> {
    const prev = this.kpiWriteQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const current = await this.getKpiBaseline(sessionId);
      const updated = updater(current);
      const sessionDir = this.getSessionDir(sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(this.getKpiBaselinePath(sessionId), JSON.stringify(updated, null, 2), 'utf-8');
    });
    this.kpiWriteQueues.set(sessionId, next.catch(() => {}));
    await next;
  }
}
