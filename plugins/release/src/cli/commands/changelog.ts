/**
 * Release changelog command — thin adapter over planRelease + createChangelogGenerator.
 */

import { join } from 'node:path';
import { stat, writeFile, mkdir, readFile } from 'node:fs/promises';
import { defineCommand, type CLIInput, type PluginCommandContextV3, useLLM, useLoader, displayArtifacts, type ArtifactInfo, useConfig, type CommandResult } from '@kb-labs/sdk';
import { planRelease, type ReleaseConfig } from '../../core/index.js';
import { findRepoRoot } from '../../shared/utils';
import { createChangelogGenerator } from '../../shared/changelog-factory';

interface ChangelogFlags {
  scope?: string;
  flow?: string;
  from?: string;
  to?: string;
  'since-tag'?: string;
  format?: 'json' | 'md' | 'both';
  level?: 'compact' | 'standard' | 'detailed';
  template?: string;
  'breaking-only'?: boolean;
  json?: boolean;
}

interface ChangelogPayload {
  packagesCount: number;
  markdown?: string;
  artifacts?: Array<{ name: string; path: string; size: number }>;
}

// ── helpers ────────────────────────────────────────────────────────────────

async function resolveGitCwd(
  scope: string | undefined,
  packages: Array<{ path: string }>,
  repoRoot: string,
): Promise<string> {
  if (!scope || !packages[0]) { return repoRoot; }
  try {
    return await findRepoRoot(packages[0].path);
  } catch {
    return packages[0].path;
  }
}

/** Remove a version block from existing changelog content, if present. */
function removeExistingVersionBlock(existing: string, newMarkdown: string): string {
  const newVersionMatch = newMarkdown.match(/^## \[([^\]]+)\]/m);
  if (!newVersionMatch) { return existing; }

  const versionHeader = `## [${newVersionMatch[1]}]`;
  const blockStart = existing.indexOf(versionHeader);
  if (blockStart === -1) { return existing; }

  const nextBlockStart = existing.indexOf('\n## [', blockStart + 1);
  const blockEnd = nextBlockStart !== -1 ? nextBlockStart : existing.length;
  const before = existing.substring(0, blockStart).trimEnd();
  const after = existing.substring(blockEnd).trimStart();
  return before && after ? `${before}\n\n${after}` : before || after;
}

/** Read existing changelog, strip footer + duplicate version, then prepend new content. */
async function mergeChangelogContent(changelogPath: string, newMarkdown: string): Promise<string> {
  let existing = '';
  try {
    existing = await readFile(changelogPath, 'utf-8');
    const footerStart = existing.indexOf('\n---\n\n*Generated automatically');
    if (footerStart !== -1) { existing = existing.substring(0, footerStart); }
    existing = removeExistingVersionBlock(existing, newMarkdown);
  } catch { /* file doesn't exist yet */ }
  return existing ? `${newMarkdown}\n\n${existing}` : newMarkdown;
}

function buildChangelogSections(
  plan: { packages: Array<{ name: string }> },
  format: string,
  artifacts: ArtifactInfo[],
): Array<{ header?: string; items: string[] }> {
  const sections: Array<{ header?: string; items: string[] }> = [];
  sections.push({
    header: 'Summary',
    items: [
      `Packages: ${plan.packages.map(p => p.name).join(', ')}`,
      `Format: ${format === 'both' ? 'Markdown + JSON' : format}`,
    ],
  });
  if (artifacts.length > 0) {
    sections.push({
      header: 'Artifacts',
      items: displayArtifacts(artifacts, { showSize: true, showTime: true, showDescription: true, maxItems: 10, title: '' }),
    });
  }
  return sections;
}

// ── command ────────────────────────────────────────────────────────────────

export default defineCommand({
  id: 'release:changelog',
  description: 'Generate changelog from conventional commits',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<ChangelogFlags>): Promise<CommandResult<ChangelogPayload>> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const loader = useLoader('Loading configuration...');
      loader.start();

      const fileConfig = await useConfig<ReleaseConfig>();
      const config: ReleaseConfig = fileConfig ?? {};

      loader.update({ text: 'Discovering packages...' });
      const plan = await planRelease({ cwd: repoRoot, config, scope: flags.scope, flow: flags.flow });

      if (plan.packages.length === 0) {
        loader.fail(`No packages found matching scope: ${flags.scope || 'all'}`);
        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Command failed', hint: "Run `kb release changelog show --help` to review its inputs and recovery steps, then retry." } };
      }

      const gitCwd = await resolveGitCwd(flags.scope, plan.packages, repoRoot);

      loader.update({ text: 'Generating changelog...' });
      const llm = useLLM();
      const generator = createChangelogGenerator(config, llm ?? undefined);
      const markdown = await generator.generate(plan, {
        repoRoot,
        gitCwd,
        config,
        flow: flags.flow,
        range: { from: flags.from, to: flags.to, sinceTag: flags['since-tag'] },
      });

      const format = flags.format || config.changelog?.format || 'both';
      const outputDir = join(repoRoot, '.kb', 'release');
      const artifacts: ArtifactInfo[] = [];

      if (!flags.json) {
        loader.update({ text: 'Saving artifacts...' });
        await mkdir(outputDir, { recursive: true });

        if (markdown && (format === 'md' || format === 'both')) {
          const changelogPath = join(outputDir, 'CHANGELOG.md');
          const combined = await mergeChangelogContent(changelogPath, markdown);
          await writeFile(changelogPath, combined, 'utf-8');
          const stats = await stat(changelogPath);
          artifacts.push({
            name: 'Changelog',
            path: changelogPath,
            size: stats.size,
            modified: stats.mtime,
            description: 'Generated changelog in Markdown format',
          });
        }
      }

      loader.succeed('Changelog generated successfully');

      if (flags.json) {
        return {
          packagesCount: plan.packages.length,
          markdown: format === 'md' || format === 'both' ? markdown : undefined,
          artifacts: artifacts.map(a => ({ name: a.name, path: a.path, size: a.size ?? 0 })),
        };
      } else {
        ctx.ui?.sideBox?.({
          title: 'Changelog Generated',
          sections: buildChangelogSections(plan, format, artifacts),
          status: 'success',
        });
      }

      return {
        packagesCount: plan.packages.length,
        markdown: format === 'md' || format === 'both' ? markdown : undefined,
        artifacts: artifacts.map(a => ({ name: a.name, path: a.path, size: a.size ?? 0 })),
      };
    },
  },
});
