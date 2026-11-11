import { z } from 'zod';

// ─── Mode ────────────────────────────────────────────────────────────────────

export const DevlinkModeSchema = z.enum(['local', 'npm', 'auto']);
export type DevlinkMode = z.infer<typeof DevlinkModeSchema>;

// ─── Package Map ──────────────────────────────────────────────────────────────

export const PackageEntrySchema = z.object({
  /** npm package name e.g. @kb-labs/core-platform */
  name: z.string(),
  /** Relative path for link: resolution e.g. ../kb-labs-core/packages/core-platform */
  linkPath: z.string(),
  /** npm version e.g. ^1.0.0 */
  npmVersion: z.string(),
  /** Source monorepo dir name e.g. kb-labs-core */
  monorepo: z.string(),
  /** Whether package.json has "private": true (stays as link: in npm mode) */
  private: z.boolean().optional(),
});
export type PackageEntry = z.infer<typeof PackageEntrySchema>;

export const PackageMapSchema = z.record(z.string(), PackageEntrySchema);
export type PackageMap = z.infer<typeof PackageMapSchema>;

// ─── Plan ─────────────────────────────────────────────────────────────────────

export const DevlinkPlanItemSchema = z.object({
  /** Absolute path to the package.json file to modify */
  packageJsonPath: z.string(),
  /** Relative path to packageJsonPath from repo root (for display) */
  packageJsonRel: z.string(),
  /** Owner monorepo e.g. kb-labs-cli */
  monorepo: z.string(),
  /** The dependency package being changed e.g. @kb-labs/core-platform */
  depName: z.string(),
  /** Current value in package.json */
  from: z.string(),
  /** New value to write */
  to: z.string(),
  /** Section: dependencies | devDependencies | peerDependencies */
  section: z.enum(['dependencies', 'devDependencies', 'peerDependencies']),
});
export type DevlinkPlanItem = z.infer<typeof DevlinkPlanItemSchema>;

export const DevlinkPlanSchema = z.object({
  mode: DevlinkModeSchema,
  items: z.array(DevlinkPlanItemSchema),
  timestamp: z.string(),
  /** Filtered to specific repos if --repos flag was used */
  scopedRepos: z.array(z.string()).optional(),
});
export type DevlinkPlan = z.infer<typeof DevlinkPlanSchema>;

// ─── State ────────────────────────────────────────────────────────────────────

export const DevlinkStateSchema = z.object({
  currentMode: DevlinkModeSchema.nullable(),
  lastApplied: z.string().nullable(),
  frozenAt: z.string().nullable(),
});
export type DevlinkState = z.infer<typeof DevlinkStateSchema>;

// ─── Backup ───────────────────────────────────────────────────────────────────

export const DevlinkBackupSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  description: z.string(),
  /** List of package.json paths that were backed up */
  files: z.array(z.string()),
  /** Mode that was active before backup was created */
  modeAtBackup: DevlinkModeSchema.nullable(),
});
export type DevlinkBackup = z.infer<typeof DevlinkBackupSchema>;

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export const DiagnosticIssueSchema = z.object({
  type: z.enum(['broken-link', 'cross-repo-workspace', 'stale-lockfile', 'stale-workspace-yaml']),
  severity: z.enum(['error', 'warning']),
  file: z.string(),
  dep: z.string().optional(),
  message: z.string(),
  fix: z.string(),
});
export type DiagnosticIssue = z.infer<typeof DiagnosticIssueSchema>;

// ─── Status ───────────────────────────────────────────────────────────────────

export const DependencyModeSchema = z.enum(['local', 'npm', 'workspace', 'mixed', 'unknown']);
export type DependencyMode = z.infer<typeof DependencyModeSchema>;

export const DevlinkStatusSchema = z.object({
  currentMode: DevlinkModeSchema.nullable(),
  lastApplied: z.string().nullable(),
  linkCount: z.number(),
  npmCount: z.number(),
  workspaceCount: z.number(),
  discrepancies: z.array(z.object({
    packageJsonPath: z.string(),
    depName: z.string(),
    value: z.string(),
    expected: z.string(),
  })),
});
export type DevlinkStatus = z.infer<typeof DevlinkStatusSchema>;
