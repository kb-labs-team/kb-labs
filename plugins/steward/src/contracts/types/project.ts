import type { Timestamped } from './common.js';

export type ProjectStatus = 'active' | 'paused' | 'archived';

export interface Project extends Timestamped {
  name: string;
  status: ProjectStatus;
  description?: string;
}

/**
 * Universal attachment on a project — repo, dev/prod stand, dashboard, doc...
 * `type` is a free string on purpose (see ADR-0001 §Resource).
 * `url` and `content` may both be set, or either alone.
 */
export interface Resource extends Timestamped {
  projectId: string;
  type: string;
  label: string;
  url?: string;
  content?: string;
}
