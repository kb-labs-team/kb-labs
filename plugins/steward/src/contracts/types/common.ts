/**
 * System fields every stored document carries. Structurally compatible with
 * the platform's `BaseDocument` (`@kb-labs/core-platform`) without importing
 * it — contracts stays dependency-free beyond zod.
 */
export interface Timestamped {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** The set of entities an `Event` can be attached to. */
export type EventSubjectType = 'project' | 'person' | 'commitment' | 'company' | 'resource';
