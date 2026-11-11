/**
 * Template system types for changelog customization
 */

import type { PackageRelease, Change, CommitType, BreakingChange, VersionBump } from '../types';
import type { ILLM, ILogger, IAnalytics } from '@kb-labs/sdk';

/**
 * Changelog group definition — maps scopes to a named section
 */
export interface ChangelogGroup {
  title: string;
  emoji?: string;
  scopes: string[];
}

/**
 * Template data structure passed to render function
 */
export interface TemplateData {
  package: {
    name: string;
    prev: string;
    next: string;
    bump: VersionBump;
    reason: 'breaking' | 'feat' | 'fix' | 'perf' | 'ripple' | 'manual';
    rippleFrom?: string[];
  };
  breaking: BreakingChange[];
  changes: Partial<Record<CommitType, Change[]>>;
  locale: 'en' | 'ru';
  metadata?: Record<string, unknown>; // Custom user metadata from config
  /** Groups config from changelog.groups — if present, template should render by groups instead of by type */
  groups?: ChangelogGroup[];
}

/**
 * Minimal platform interface for LLM access, logging, and analytics
 */
export interface PlatformLike {
  llm?: ILLM;
  logger?: ILogger;
  analytics?: IAnalytics;
}

/**
 * Template contract - all templates must implement this interface
 *
 * Templates can be sync (fast) or async (with LLM enhancement)
 */
export interface ChangelogTemplate {
  /**
   * Template API version (semver major)
   * Current: '1.0'
   */
  version: '1.0';

  /**
   * Render changelog for a package
   * @param data Template data with package info, changes, etc
   * @param platform Optional platform for LLM access
   * @returns Markdown-formatted changelog string (sync or async)
   */
  render(data: TemplateData, platform?: PlatformLike): string | Promise<string>;
}

/**
 * Helper to group changes by type
 */
export function groupChangesByType(changes: Change[]): Partial<Record<CommitType, Change[]>> {
  const grouped: Partial<Record<CommitType, Change[]>> = {};

  for (const change of changes) {
    const type = change.type;
    if (!grouped[type]) {
      grouped[type] = [];
    }
    grouped[type]!.push(change);
  }

  return grouped;
}

/**
 * Convert PackageRelease to TemplateData
 */
export function packageToTemplateData(
  pkg: PackageRelease,
  locale: 'en' | 'ru' = 'en',
  metadata?: Record<string, unknown>,
  groups?: ChangelogGroup[]
): TemplateData {
  return {
    package: {
      name: pkg.name,
      prev: pkg.prev,
      next: pkg.next,
      bump: pkg.bump,
      reason: pkg.reason,
      rippleFrom: pkg.rippleFrom,
    },
    breaking: pkg.breaking,
    changes: groupChangesByType(pkg.changes),
    locale,
    metadata,
    groups,
  };
}
