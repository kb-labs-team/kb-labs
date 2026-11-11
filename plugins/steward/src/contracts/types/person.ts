import type { Timestamped } from './common.js';

export type ContactChannel = 'telegram' | 'email' | 'phone' | 'other';

export interface Contact {
  channel: ContactChannel;
  value: string;
  /** Lower = preferred. Used to pick the primary channel when several exist. */
  priority: number;
}

/** Global contact — not owned by any single project. */
export interface Person extends Timestamped {
  name: string;
  contacts: Contact[];
  companyId?: string;
  /** Competencies reachable from any project — see ADR-0001 §Routing. */
  globalTopics: string[];
}

/**
 * Thin entity: `{id, name}` only in MVP. The link (`Person.companyId`) is
 * fixed now precisely so company-level features can grow later without a
 * migration — see ADR-0001 §"Миграционная политика".
 */
export interface Company extends Timestamped {
  name: string;
}

/** Person ↔ Project link. `priority` doubles as the whoToContact fallback order. */
export interface ProjectMember extends Timestamped {
  personId: string;
  projectId: string;
  role: string;
  /** Competencies in the context of this project — augments `globalTopics`. */
  topics?: string[];
  /** Lower = contacted first when multiple members match a topic. */
  priority: number;
}
