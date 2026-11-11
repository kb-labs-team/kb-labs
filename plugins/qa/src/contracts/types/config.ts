export interface QAPluginConfig {
  /** Path or name of the kb-devkit binary. Default: workspace-local then PATH. */
  devkitPath?: string;
  /** Maximum history entries kept per snapshot kind. Default: 50. */
  historyMaxEntries?: number;
  /** Default task list for `kb qa run`. Default: ["build", "lint", "type-check", "test"]. */
  defaultTasks?: string[];
  /** CI evidence collection and analysis settings. */
  ci?: QACiConfig;
  /** Case catalog directory. Default: docs/qa/scenarios. */
  casesPath?: string;
}

export interface QACiConfig {
  /** CI provider used when a command does not supply one. */
  provider?: 'github-actions';
  /** GitHub repository in owner/name form. Defaults to GITHUB_REPOSITORY. */
  repository?: string;
  /** Branch that contains durable QA snapshots. Default: ci-data. */
  dataBranch?: string;
  /** Retention used by the producer when publishing GitHub artifacts. Default: 90. */
  artifactRetentionDays?: number;
  /** Workflow names included in reliability analysis. */
  workflows?: string[];
}
