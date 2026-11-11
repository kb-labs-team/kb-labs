/**
 * Shared changelog generator factory.
 * Used by both CLI (run.ts) and REST (run-handler.ts) to avoid duplication.
 */

import {
  generateChangelog,
  generateSimpleChangelog,
  type ChangelogPackageInfo,
} from '../changelog/index.js';
import type { ReleaseConfig, ChangelogGenerator } from '../core/index.js';
import { buildReleaseTag } from '../core/index.js';
import type { ILLM } from '@kb-labs/sdk';

export function createChangelogGenerator(config: ReleaseConfig, llm?: ILLM): ChangelogGenerator {
  return {
    async generate(plan, opts) {
      const locale = (config.changelog?.locale as 'en' | 'ru') || 'en';
      const packages: ChangelogPackageInfo[] = plan.packages.map(pkg => ({
        name: pkg.name,
        path: pkg.path,
        currentVersion: pkg.currentVersion,
        nextVersion: pkg.nextVersion,
        bump: pkg.bump === 'auto' ? 'patch' : pkg.bump,
      }));
      try {
        const result = await generateChangelog({
          repoRoot: opts.repoRoot,
          gitCwd: opts.gitCwd,
          packages,
          range: {
            ...opts.range,
            to: opts.range?.to ?? 'HEAD',
            tagGlob: opts.flow
              ? buildReleaseTag(opts.flow, '*', config.flows?.[opts.flow]?.tagPattern)
              : undefined,
          },
          changelog: {
            template: config.changelog?.template ?? undefined,
            locale,
            metadata: config.changelog?.metadata,
            ignoreAuthors: config.changelog?.ignoreAuthors,
            includeTypes: config.changelog?.includeTypes as string[],
            excludeTypes: config.changelog?.excludeTypes as string[],
            collapseMerges: config.changelog?.collapseMerges,
            collapseReverts: config.changelog?.collapseReverts,
            preferMergeSummary: config.changelog?.preferMergeSummary,
            groups: config.changelog?.groups,
          },
          git: {
            autoUnshallow: config.git?.autoUnshallow,
            requireSignedTags: config.git?.requireSignedTags,
            baseUrl: config.git?.baseUrl ?? undefined,
          },
          platform: llm ? { llm } : undefined,
        });
        return result.markdown;
      } catch {
        return generateSimpleChangelog(packages, locale);
      }
    },
  };
}
