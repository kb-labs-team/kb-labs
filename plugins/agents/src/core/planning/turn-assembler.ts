/**
 * @module @kb-labs/agents/core/planning/turn-assembler
 * Assembles Turn snapshots from raw AgentEvent stream
 */

import type {
  AgentEvent,
  ToolEndEvent,
  Turn,
  ThinkingStep,
  ToolUseStep,
  TextStep,
  ErrorStep,
} from '../../contracts/index.js';

/**
 * Pending tool:end / tool:error event that arrived before its tool:start.
 * Buffered per turnId, keyed by toolCallId or toolName.
 */
interface PendingToolResult {
  event: AgentEvent;
  type: 'tool:end' | 'tool:error';
}

/**
 * Assembles Turn snapshots from raw AgentEvent stream.
 * Maintains state for in-progress turns and emits snapshots on updates.
 *
 * Out-of-order tolerance: when tool:end / tool:error arrive before their
 * corresponding tool:start (due to fire-and-forget async dispatch), the
 * result event is buffered in orphanedToolResults. As soon as tool:start
 * is processed the buffer is flushed, guaranteeing the step ends up in
 * the correct final state.
 */
export class TurnAssembler {
  /** Active turns being assembled (turnId -> Turn) */
  private activeTurns = new Map<string, Turn>();

  /** Event buffer for each turn (for replay/debugging) */
  private eventBuffers = new Map<string, AgentEvent[]>();

  /** Next sequence number per session */
  private sequenceCounters = new Map<string, number>();

  /**
   * Orphaned tool result events (tool:end / tool:error) that arrived before
   * their corresponding tool:start. Key: `${turnId}:${toolCallId|toolName}`.
   */
  private orphanedToolResults = new Map<string, PendingToolResult[]>();

  /**
   * Process an event and return updated Turn snapshot if changed.
   * Returns null if no snapshot update needed.
   */
  processEvent(event: AgentEvent): Turn | null {
    // Determine turn ID from event
    const turnId = this.getTurnId(event);
    if (!turnId) {return null;} // Event doesn't belong to a turn

    // Get or create turn
    let turn = this.activeTurns.get(turnId);
    if (!turn) {
      turn = this.createTurn(event, turnId);
      this.activeTurns.set(turnId, turn);
    }

    // Buffer event for debugging
    const buffer = this.eventBuffers.get(turnId) ?? [];
    buffer.push(event);
    this.eventBuffers.set(turnId, buffer);

    // Update turn based on event type
    const updated = this.updateTurn(turn, event, turnId);

    // Check if turn completed
    let completed = false;
    if (this.isTurnComplete(event)) {
      turn.status = 'completed';
      turn.completedAt = event.timestamp;
      this.activeTurns.delete(turnId);
      this.eventBuffers.delete(turnId);
      completed = true;
    }

    // Return turn if updated OR if it just completed (so caller can persist final status)
    return (updated || completed) ? turn : null;
  }

  /**
   * Async version of processEvent that uses external sequence generator.
   * Used when sequence needs to be persistent across SessionManager instances.
   */
  async processEventAsync(
    event: AgentEvent,
    getSequence: (sessionId: string) => Promise<number>
  ): Promise<Turn | null> {
    // Determine turn ID from event
    const turnId = this.getTurnId(event);
    if (!turnId) {return null;}

    // Get or create turn
    let turn = this.activeTurns.get(turnId);
    if (!turn) {
      turn = await this.createTurnAsync(event, turnId, getSequence);
      this.activeTurns.set(turnId, turn);
    }

    // Buffer event for debugging
    const buffer = this.eventBuffers.get(turnId) ?? [];
    buffer.push(event);
    this.eventBuffers.set(turnId, buffer);

    // Update turn based on event type
    const updated = this.updateTurn(turn, event, turnId);

    // Check if turn completed
    let completed = false;
    if (this.isTurnComplete(event)) {
      turn.status = 'completed';
      turn.completedAt = event.timestamp;
      this.activeTurns.delete(turnId);
      this.eventBuffers.delete(turnId);
      completed = true;
    }

    return (updated || completed) ? turn : null;
  }

  /**
   * Public wrapper around getTurnId, for callers that need to snapshot the
   * turn's pre-mutation state (e.g. to diff against post-mutation state)
   * before calling processEventAsync.
   */
  getTurnIdForEvent(event: AgentEvent): string | null {
    return this.getTurnId(event);
  }

  /**
   * Peek at the current in-progress turn for a turn id, WITHOUT mutating
   * anything. Returns a live reference (not a clone) — the assembler
   * mutates turn/step objects in place, so callers that need a stable
   * "before" snapshot must clone this themselves before calling
   * processEventAsync.
   */
  peekTurn(turnId: string): Turn | undefined {
    return this.activeTurns.get(turnId);
  }

  /**
   * Derive turn ID from event.
   * For root agents: use agentId
   * For sub-agents: return null (handled separately)
   */
  private getTurnId(event: AgentEvent): string | null {
    switch (event.type) {
      case 'agent:start':
      case 'agent:end':
      case 'agent:error':
        // Root agent events = turn boundaries
        return event.parentAgentId ? null : `turn-${event.agentId}`;

      case 'llm:start':
      case 'llm:stream':
      case 'llm:end':
      case 'tool:start':
      case 'tool:end':
      case 'tool:error':
      case 'status:change':
      case 'thinking:start':
      case 'thinking:chunk':
      case 'thinking:end':
        // Associate with current turn (assume belongs to most recent active turn)
        // In production, this should use event.metadata.turnId or similar
        const activeTurnIds = Array.from(this.activeTurns.keys());
        return activeTurnIds[activeTurnIds.length - 1] ?? null;

      default:
        return null;
    }
  }

  /**
   * Create initial Turn snapshot from agent:start event.
   */
  private createTurn(event: AgentEvent, turnId: string): Turn {
    const sessionId = event.sessionId ?? 'unknown';

    // Use getNextSequence to properly increment counter
    // This ensures user turns and assistant turns have correct sequence order
    const sequence = this.getNextSequence(sessionId);

    return {
      id: turnId,
      type: 'assistant',
      sequence,
      startedAt: event.timestamp,
      completedAt: null,
      status: 'streaming',
      steps: [],
      metadata: {
        agentId: event.agentId ?? 'unknown',
        agentName: undefined,
        taskId: event.taskId,
      },
    };
  }

  /**
   * Async version of createTurn that uses external sequence generator.
   */
  private async createTurnAsync(
    event: AgentEvent,
    turnId: string,
    getSequence: (sessionId: string) => Promise<number>
  ): Promise<Turn> {
    const sessionId = event.sessionId ?? 'unknown';

    // Get sequence from external source (file system)
    const sequence = await getSequence(sessionId);

    return {
      id: turnId,
      type: 'assistant',
      sequence,
      startedAt: event.timestamp,
      completedAt: null,
      status: 'streaming',
      steps: [],
      metadata: {
        agentId: event.agentId ?? 'unknown',
        agentName: undefined,
        taskId: event.taskId,
      },
    };
  }

  /**
   * Update turn with new event data.
   * Returns true if turn was modified.
   */
  private updateTurn(turn: Turn, event: AgentEvent, turnId: string): boolean {
    switch (event.type) {
      case 'thinking:start':
      case 'thinking:chunk': {
        // Find or create thinking step
        const lastStep = turn.steps[turn.steps.length - 1];
        const content = (event.data?.content as string) ?? '';

        if (lastStep?.type === 'thinking') {
          // Append to existing thinking
          (lastStep as ThinkingStep).content += content;
          return true;
        } else {
          // Create new thinking step
          const step: ThinkingStep = {
            type: 'thinking',
            id: `step-${turn.steps.length + 1}`,
            timestamp: event.timestamp,
            content,
          };
          turn.steps.push(step);
          return true;
        }
      }

      case 'status:change': {
        const statusPayload = (event.data ?? {}) as {
          status?: string;
          message?: string;
          toolName?: string;
        };
        const content = this.buildPublicStatusReasoning(statusPayload);
        if (!content) {
          return false;
        }

        const lastStep = turn.steps[turn.steps.length - 1];
        if (lastStep?.type === 'thinking' && lastStep.content === content) {
          return false;
        }

        const step: ThinkingStep = {
          type: 'thinking',
          id: `step-${turn.steps.length + 1}`,
          timestamp: event.timestamp,
          content,
        };
        turn.steps.push(step);
        return true;
      }

      case 'tool:start': {
        const startMeta = event.data?.metadata;
        const toolCallId = event.toolCallId;
        const toolName = event.data?.toolName ?? 'unknown';
        const step: ToolUseStep = {
          type: 'tool_use',
          id: `step-${turn.steps.length + 1}`,
          timestamp: event.timestamp,
          toolName,
          toolCallId,
          input: (event.data?.input as Record<string, unknown>) ?? {},
          status: 'pending',
          ...(startMeta ? {
            metadata: {
              filePath: startMeta.filePath,
              summary: startMeta.summary,
              uiHint: startMeta.uiHint,
              structured: startMeta.structured,
            }
          } : {}),
        };
        turn.steps.push(step);

        // Flush any orphaned tool:end / tool:error that arrived before this start
        this.flushOrphanedToolResults(turn, turnId, step);

        return true;
      }

      case 'tool:end': {
        const toolCallId = event.toolCallId;
        const toolName = event.data?.toolName ?? 'unknown';
        const existing = turn.steps.find(
          (s): s is ToolUseStep =>
            s.type === 'tool_use' &&
            s.status === 'pending' &&
            (toolCallId ? s.toolCallId === toolCallId : s.toolName === toolName)
        );
        if (existing) {
          this.applyToolEnd(existing, event);
        } else {
          // tool:start hasn't been processed yet — buffer for later
          this.bufferOrphanedToolResult(turnId, toolCallId, toolName, { event, type: 'tool:end' });
        }
        return true;
      }

      case 'tool:error': {
        const toolCallId = event.toolCallId;
        const toolName = event.data?.toolName ?? 'unknown';
        const existing = turn.steps.find(
          (s): s is ToolUseStep =>
            s.type === 'tool_use' &&
            s.status === 'pending' &&
            (toolCallId ? s.toolCallId === toolCallId : s.toolName === toolName)
        );
        if (existing) {
          existing.status = 'error';
          existing.error = (event.data?.error as string) ?? 'Unknown error';
        } else {
          // tool:start hasn't been processed yet — buffer for later
          this.bufferOrphanedToolResult(turnId, toolCallId, toolName, { event, type: 'tool:error' });
        }
        return true;
      }

      case 'llm:end': {
        const rawContent = (event.data?.content as string | undefined) ?? '';
        const content = this.sanitizePublicContent(rawContent);
        const hasToolCalls = Boolean((event.data as { hasToolCalls?: boolean } | undefined)?.hasToolCalls);

        if (content) {
          if (hasToolCalls) {
            const step: ThinkingStep = {
              type: 'thinking',
              id: `step-${turn.steps.length + 1}`,
              timestamp: event.timestamp,
              content,
            };
            turn.steps.push(step);
          } else {
            const step: TextStep = {
              type: 'text',
              id: `step-${turn.steps.length + 1}`,
              timestamp: event.timestamp,
              content,
              role: 'assistant',
            };
            turn.steps.push(step);
          }

          // Update metadata
          if (event.data?.tokensUsed) {
            turn.metadata.totalTokens = (turn.metadata.totalTokens ?? 0) + event.data.tokensUsed;
          }

          return true;
        }
        return false;
      }

      case 'agent:end': {
        // Add a TextStep from the final summary only if no TextStep exists yet.
        // When the agent uses the report tool, llm:end has empty content — summary is the only source.
        // When the agent ends with a text-only LLM reply, llm:end already added the TextStep.
        const hasTextStep = turn.steps.some((s) => s.type === 'text');
        if (!hasTextStep) {
          const summary = (event.data?.summary as string | undefined)?.trim();
          if (summary) {
            const step: TextStep = {
              type: 'text',
              id: `step-${turn.steps.length + 1}`,
              timestamp: event.timestamp,
              content: summary,
              role: 'assistant',
            };
            turn.steps.push(step);
            return true;
          }
        }
        return false;
      }

      case 'agent:error': {
        turn.status = 'failed';
        turn.completedAt = event.timestamp;
        turn.error = {
          code: 'AGENT_ERROR',
          message: event.data?.error ?? 'Agent failed',
          details: undefined,
        };
        const step: ErrorStep = {
          type: 'error',
          id: `step-${turn.steps.length + 1}`,
          timestamp: event.timestamp,
          code: turn.error.code,
          message: turn.error.message,
          details: turn.error.details,
        };
        turn.steps.push(step);
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Check if event marks turn completion.
   */
  private isTurnComplete(event: AgentEvent): boolean {
    return event.type === 'agent:end' && !event.parentAgentId;
  }

  // ─── Out-of-order tool result buffering ─────────────────────────────────

  /**
   * Build the orphan buffer key for a tool result.
   * Prefer toolCallId (unique per invocation) over toolName (may repeat).
   */
  private orphanKey(turnId: string, toolCallId: string | undefined, toolName: string): string {
    return toolCallId ? `${turnId}:id:${toolCallId}` : `${turnId}:name:${toolName}`;
  }

  /**
   * Buffer an orphaned tool:end / tool:error event so it can be applied
   * once the matching tool:start step is created.
   */
  private bufferOrphanedToolResult(
    turnId: string,
    toolCallId: string | undefined,
    toolName: string,
    pending: PendingToolResult
  ): void {
    const key = this.orphanKey(turnId, toolCallId, toolName);
    const existing = this.orphanedToolResults.get(key) ?? [];
    existing.push(pending);
    this.orphanedToolResults.set(key, existing);
  }

  /**
   * After a tool:start step is pushed, flush any buffered results for it.
   */
  private flushOrphanedToolResults(turn: Turn, turnId: string, step: ToolUseStep): void {
    // Try lookup by toolCallId first, then fall back to toolName
    const keyById = step.toolCallId ? `${turnId}:id:${step.toolCallId}` : null;
    const keyByName = `${turnId}:name:${step.toolName}`;

    const pendingById = keyById ? this.orphanedToolResults.get(keyById) : undefined;
    const pendingByName = this.orphanedToolResults.get(keyByName);

    const pending = pendingById ?? pendingByName;
    const usedKey = pendingById ? keyById! : keyByName;

    if (!pending || pending.length === 0) {
      return;
    }

    // Apply the most recent result (last wins — same semantics as live processing)
    const last = pending[pending.length - 1]!;
    if (last.type === 'tool:end') {
      this.applyToolEnd(step, last.event as ToolEndEvent);
    } else {
      step.status = 'error';
      const errData = last.event.data as { error?: string } | undefined;
      step.error = errData?.error ?? 'Unknown error';
    }

    this.orphanedToolResults.delete(usedKey);
  }

  /**
   * Apply a tool:end event payload to an existing ToolUseStep.
   */
  private applyToolEnd(step: ToolUseStep, event: ToolEndEvent): void {
    step.status = 'done';
    step.success = event.data?.success;
    step.output = event.data?.output;
    step.durationMs = event.data?.durationMs;
    const m = event.data?.metadata;
    if (m) {
      step.metadata = {
        filePath: m.filePath,
        fileContent: m.fileContent,
        diff: m.diff,
        oldContent: m.oldContent,
        newContent: m.newContent,
        linesChanged: m.linesChanged,
        linesAdded: m.linesAdded,
        linesRemoved: m.linesRemoved,
        resultCount: m.resultCount,
        results: m.results,
        confidence: m.confidence,
        query: m.query,
        exitCode: m.exitCode,
        command: m.command,
        stdout: m.stdout,
        stderr: m.stderr,
        summary: m.summary,
        uiHint: m.uiHint,
        structured: m.structured,
      };
    }
  }

  private sanitizePublicContent(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) {
      return '';
    }
    const normalized = trimmed.toLowerCase();
    if (
      normalized === '[executing tools...]' ||
      normalized === '[thinking...]' ||
      normalized === '[planning...]' ||
      normalized === '[analyzing...]'
    ) {
      return '';
    }
    return trimmed;
  }

  private buildPublicStatusReasoning(payload: { status?: string; message?: string; toolName?: string }): string | null {
    const status = (payload.status ?? '').toLowerCase();
    const message = (payload.message ?? '').trim();

    if (status === 'thinking') {
      return 'Analyzing context and choosing the next step.';
    }

    if (status === 'executing' && payload.toolName) {
      return `Checking facts with tool: ${this.formatToolName(payload.toolName)}.`;
    }

    if (!message) {
      return null;
    }

    const normalized = message.toLowerCase();
    if (normalized.includes('calling llm')) {
      return 'Reviewing context and planning the next action.';
    }
    if (normalized.includes('executing')) {
      return payload.toolName
        ? `Running step with tool: ${this.formatToolName(payload.toolName)}.`
        : 'Running the next step and collecting evidence.';
    }

    return null;
  }

  private formatToolName(name: string): string {
    return name
      .replace(/[_-]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Get all active turns (for session snapshots).
   */
  getActiveTurns(): Turn[] {
    return Array.from(this.activeTurns.values());
  }

  /**
   * Get next sequence number for a session (for user turns).
   * Also increments the counter so next turn gets a different sequence.
   */
  getNextSequence(sessionId: string): number {
    const current = this.sequenceCounters.get(sessionId) ?? 0;
    const next = current + 1;
    this.sequenceCounters.set(sessionId, next);
    return next;
  }

  /**
   * Get current sequence counter value (for testing/debugging).
   */
  getCurrentSequence(sessionId: string): number {
    return this.sequenceCounters.get(sessionId) ?? 0;
  }

  /**
   * Clear all state (for testing/cleanup).
   */
  reset(): void {
    this.activeTurns.clear();
    this.eventBuffers.clear();
    this.sequenceCounters.clear();
    this.orphanedToolResults.clear();
  }
}
