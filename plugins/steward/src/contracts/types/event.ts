import type { Timestamped, EventSubjectType } from './common.js';

export type EventKind =
  // semantic — never retained-out, see ADR-0001 §"Ретеншен событий"
  | 'note'
  | 'project.created'
  | 'project.status_changed'
  | 'commitment.created'
  | 'commitment.done'
  | 'commitment.dropped'
  | 'commitment.rescheduled'
  | 'person.merged'
  // derived — 90 day retention
  | 'review.generated'
  | 'integrity.checked'
  | 'export.completed'
  // trace — 14 day retention
  | 'backfill.imported';

export const SEMANTIC_EVENT_KINDS: readonly EventKind[] = [
  'note',
  'project.created',
  'project.status_changed',
  'commitment.created',
  'commitment.done',
  'commitment.dropped',
  'commitment.rescheduled',
  'person.merged',
];

export const DERIVED_EVENT_KINDS: readonly EventKind[] = [
  'review.generated',
  'integrity.checked',
  'export.completed',
];

export const TRACE_EVENT_KINDS: readonly EventKind[] = ['backfill.imported'];

/**
 * Append-only history log — the thing that makes the memory "infinite".
 * `subjectType`/`subjectId` are a polymorphic reference on purpose (flat,
 * not nested — `DocumentFilter` only supports top-level keys) so new
 * entities never require a schema change here. See ADR-0001 §Event.
 */
export interface Event extends Timestamped {
  at: number;
  kind: EventKind;
  subjectType: EventSubjectType;
  subjectId: string;
  reason?: string;
  text?: string;
  meta?: Record<string, unknown>;
}
