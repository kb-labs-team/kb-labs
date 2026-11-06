/**
 * ConflictDetector — detects file conflicts before write operations.
 * Works with ChangeStore instead of the old FileChangeTracker.
 */

import type { ChangeStore } from './change-store.js';

export type ConflictType = 'none' | 'disjoint' | 'overlapping' | 'conflicting-intent' | 'semantic';

export interface DetectedConflict {
  type: ConflictType;
  filePath: string;
  /** Agent attempting the write */
  currentAgentId: string;
  /** Other agents who modified this file */
  conflictingAgents: string[];
  description: string;
  /** 0–1: higher = easier to auto-resolve */
  resolutionConfidence: number;
  metadata?: {
    overlapLines?: number[];
    intentA?: string;
    intentB?: string;
    semanticIssue?: string;
  };
}

export interface ConflictCheckInput {
  sessionId: string;
  filePath: string;
  agentId: string;
  operation: 'write' | 'patch' | 'delete';
  metadata?: {
    startLine?: number;
    endLine?: number;
    content?: string;
  };
}

export class ConflictDetector {
  constructor(private readonly store: ChangeStore) {}

  async detectConflict(input: ConflictCheckInput): Promise<DetectedConflict | null> {
    const { sessionId, filePath, agentId, operation, metadata } = input;

    const fileHistory = await this.store.listFile(sessionId, filePath);
    if (fileHistory.length === 0) {return null;}

    const otherChanges = fileHistory.filter((c) => c.agentId !== agentId);
    if (otherChanges.length === 0) {return null;}

    const conflictingAgents = [...new Set(otherChanges.map((c) => c.agentId))];
    const latest = fileHistory[fileHistory.length - 1]!;

    // Disjoint patches → safe to auto-merge
    if (operation === 'patch' && latest.operation === 'patch') {
      const overlaps = this._checkLineOverlap(
        metadata?.startLine, metadata?.endLine,
        latest.metadata?.startLine, latest.metadata?.endLine,
      );

      if (!overlaps) {
        return {
          type: 'disjoint',
          filePath,
          currentAgentId: agentId,
          conflictingAgents,
          description: 'Patches on different lines — safe to merge',
          resolutionConfidence: 1.0,
        };
      }

      const overlapLines = this._overlapLines(
        metadata?.startLine, metadata?.endLine,
        latest.metadata?.startLine, latest.metadata?.endLine,
      );
      return {
        type: 'overlapping',
        filePath,
        currentAgentId: agentId,
        conflictingAgents,
        description: `Patches overlap on lines ${overlapLines.join(', ')}`,
        resolutionConfidence: 0.7,
        metadata: { overlapLines },
      };
    }

    // Conflicting intent: one deletes, another modifies
    if (
      (operation === 'delete' && latest.operation !== 'delete') ||
      (operation !== 'delete' && latest.operation === 'delete')
    ) {
      return {
        type: 'conflicting-intent',
        filePath,
        currentAgentId: agentId,
        conflictingAgents,
        description: 'One agent deletes while another modifies',
        resolutionConfidence: 0.5,
        metadata: { intentA: operation, intentB: latest.operation },
      };
    }

    // Two full rewrites
    if (operation === 'write' && latest.operation === 'write') {
      const semanticIssue = this._detectSemanticConflict(
        latest.after.content,
        metadata?.content ?? '',
      );
      if (semanticIssue) {
        return {
          type: 'semantic',
          filePath,
          currentAgentId: agentId,
          conflictingAgents,
          description: 'Semantic conflict in file rewrites',
          resolutionConfidence: 0.3,
          metadata: { semanticIssue },
        };
      }
      return {
        type: 'overlapping',
        filePath,
        currentAgentId: agentId,
        conflictingAgents,
        description: 'Full file overwrite by multiple agents',
        resolutionConfidence: 0.6,
      };
    }

    return {
      type: 'overlapping',
      filePath,
      currentAgentId: agentId,
      conflictingAgents,
      description: 'Generic file modification conflict',
      resolutionConfidence: 0.5,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _checkLineOverlap(
    startA?: number, endA?: number,
    startB?: number, endB?: number,
  ): boolean {
    if (startA === undefined || endA === undefined || startB === undefined || endB === undefined) {
      return true; // conservative: assume overlap
    }
    return !(endA < startB || endB < startA);
  }

  private _overlapLines(
    startA?: number, endA?: number,
    startB?: number, endB?: number,
  ): number[] {
    if (startA === undefined || endA === undefined || startB === undefined || endB === undefined) {
      return [];
    }
    const from = Math.max(startA, startB);
    const to = Math.min(endA, endB);
    if (from > to) {return [];}
    const lines: number[] = [];
    for (let i = from; i <= to; i++) {lines.push(i);}
    return lines;
  }

  private _detectSemanticConflict(contentA: string, contentB: string): string | null {
    const linesA = contentA.split('\n').length;
    const linesB = contentB.split('\n').length;
    const diff = Math.abs(linesA - linesB);
    if (diff > linesA * 0.3) {
      return `Significant structural change (${diff} line difference)`;
    }
    return null;
  }
}
