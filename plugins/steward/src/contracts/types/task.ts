import type { Timestamped } from './common.js';

/**
 * Typed but not implemented in MVP — deferred as a whole new collection,
 * nothing to migrate later. See ADR-0001 §"Миграционная политика".
 */
export type TaskStatus = 'open' | 'done';

export interface Task extends Timestamped {
  title: string;
  projectId?: string;
  status: TaskStatus;
  dueDate?: number;
}
