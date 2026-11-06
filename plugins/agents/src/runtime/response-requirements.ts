import type { EvidenceRequirements } from '../contracts/index.js';

export interface RuntimeResponseRequirements {
  requirements: EvidenceRequirements;
  rationale: string;
}
