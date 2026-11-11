/**
 * Quality plugin configuration — stored in kb.config.json under "quality" section
 */

export interface QualityLayerMap {
  [pathPrefix: string]: number;
}

export interface QualityThresholds {
  /** Minimum health score before exit 1. Default: 70 */
  health: number;
  /** Instability threshold for warning. Default: 0.85 */
  instability: number;
}

export interface QualityKnipConfig {
  /** Whether to run knip for dead code / dep analysis. Default: true */
  enabled: boolean;
}

export interface QualityPluginConfig {
  /** Max snapshots to retain in history. Default: 30 */
  maxSnapshots: number;
  knip: QualityKnipConfig;
  /**
   * Layer map: path prefix → layer index.
   * Defaults to KB Labs standard layers from CLAUDE.md.
   */
  layers: QualityLayerMap;
  thresholds: QualityThresholds;
}

export const defaultQualityConfig: QualityPluginConfig = {
  maxSnapshots: 30,
  knip: {
    enabled: true,
  },
  layers: {
    'core/': 0,
    'sdk/': 1,
    'shared/': 1,
    'cli/': 2,
    'adapters/': 2,
    'plugins/': 3,
    'studio/': 4,
  },
  thresholds: {
    health: 70,
    instability: 0.85,
  },
};
