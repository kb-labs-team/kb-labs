import type { LLMTier } from '../../contracts/index.js';

export interface AgentBehaviorPolicy {
  retrieval: {
    minReadWindowLines: number;
    maxConsecutiveSmallWindowReadsPerFile: number;
    smallFileReadAllThresholdLines: number;
  };
  noResult: {
    minIterationsBeforeConclusion: number;
    maxConsecutiveNoSignalSearchByTier: Record<LLMTier, number>;
  };
  evidence: {
    minFilesReadForInformational: number;
    minEvidenceDensityForInformational: number;
    minInformationalResponseChars: number;
  };
}

export function createDefaultAgentBehaviorPolicy(): AgentBehaviorPolicy {
  return {
    retrieval: {
      minReadWindowLines: 60,
      maxConsecutiveSmallWindowReadsPerFile: 3,
      smallFileReadAllThresholdLines: 400,
    },
    noResult: {
      minIterationsBeforeConclusion: 2,
      maxConsecutiveNoSignalSearchByTier: {
        small: 2,
        medium: 2,
        large: 3,
      },
    },
    evidence: {
      minFilesReadForInformational: 1,
      minEvidenceDensityForInformational: 0.2,
      minInformationalResponseChars: 180,
    },
  };
}
