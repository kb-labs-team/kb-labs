import type { Timestamped } from './common.js';

export type CommitmentStatus = 'open' | 'done' | 'dropped';

/**
 * A promise to a person with a soft deadline — distinct from a formal task.
 * See ADR-0001 §Commitment.
 */
export interface Commitment extends Timestamped {
  text: string;
  personId?: string;
  projectId?: string;
  status: CommitmentStatus;
  remindAt?: number;
  /** Set when snoozed; review ignores the commitment until this passes. */
  snoozedUntil?: number;
  /** Days without update after which an open commitment is considered stale. */
  staleAfterDays: number;
}
