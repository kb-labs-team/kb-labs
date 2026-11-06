import type { Timestamped } from './common.js';

/**
 * Topic dictionary with aliases. Normalized on write, not on read — a
 * deterministic lookup over an uncontrolled vocabulary is worse than a
 * fuzzy one (ADR-0001 §Routing). Entries are created deliberately.
 */
export interface Topic extends Timestamped {
  name: string;
  aliases: string[];
}
