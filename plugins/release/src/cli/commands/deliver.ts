/**
 * Deliver command — verifies a sealed candidate bundle and ships its exact
 * tarballs to the configured registry. This is the thin-CI half of the
 * "plugin prepares, CI delivers" release plan: CI's only job is to have
 * the right registry credentials and call this one command with the tag —
 * package selection, tag→flow resolution, retry/backoff, and post-delivery
 * verification all live here, not in CI YAML.
 *
 * Deliberately verifies `provenance.json`, the bundle indexes, and
 * `npm/manifest.json` from `--bundle-dir` instead of rediscovering or
 * rebuilding packages. It ships the exact bytes sealed by the hosted
 * candidate builder.
 *
 * Not to be confused with `release stable publish` (`promote.ts`) — that command
 * still re-packs from the working tree at publish time (the older,
 * Verdaccio-pre-flight flow from ADR-0001) and remains in place unchanged.
 */

import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineCommand, type CLIInput, type PluginCommandContextV3, useLoader, useConfig, useEnv, type CommandResult } from '@kb-labs/sdk';
import { createValidatedErrorEnvelope } from '@kb-labs/sdk/errors';
import {
  mergeConfigWithFlow,
  resolvePublishTag,
  resolvePublishRegistry,
  verifyAgainstRegistry,
  type ReleaseConfig,
  type PublishablePackage,
} from '../../core/index.js';
import { findRepoRoot } from '../../shared/utils';
import { publishPackagesProgrammatic, type PackageToPublish } from '../../shared/publish-programmatic';
import { CandidateBundleError, verifyCandidateBundle } from '../../shared/candidate-bundle.js';
import { resolveFlowName, type FlowResolvableFlags } from '../../shared/resolve-flow';

const REGISTRY_VERIFY_RETRIES = 5;
const REGISTRY_VISIBILITY_DEADLINE_MS = 15 * 60_000;

interface DeliverFlags extends FlowResolvableFlags {
  'bundle-dir'?: string;
  'expected-digest'?: string;
  'candidate-id'?: string;
  commit?: string;
  version?: string;
  tag?: string;
  registry?: string;
  otp?: string;
  access?: string;
  'dry-run'?: boolean;
  json?: boolean;
}

interface DeliverFailure {
  name: string;
  version: string;
  error: string;
  errorCode?: string;
  errorHint?: string;
}

interface DeliverPayload {
  success: boolean;
  registry?: string;
  published?: Array<{ name: string; version: string }>;
  failed?: DeliverFailure[];
  verifyIssues?: string[];
}

/**
 * Append a markdown summary to the GitHub Actions job summary panel, when
 * running under Actions (`GITHUB_STEP_SUMMARY` is set) — otherwise a no-op.
 * This is what actually makes a failure diagnosable without digging through
 * raw step logs: the exact npm error, per package, rendered right in the
 * run's UI instead of buried in thousands of log lines.
 */
function writeGithubStepSummary(markdown: string): void {
  const summaryPath = useEnv('GITHUB_STEP_SUMMARY');
  if (!summaryPath) { return; }
  try {
    appendFileSync(summaryPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  } catch {
    // Best-effort — never let summary writing fail the actual delivery.
  }
}

function buildFailureSummaryMarkdown(registry: string, publishedCount: number, failed: DeliverFailure[]): string {
  const lines: string[] = [
    `## ❌ \`release artifact publish --registry ${registry}\` — ${failed.length} package(s) failed`,
    '',
    `${publishedCount} package(s) delivered successfully; ${failed.length} did not.`,
    '',
  ];
  for (const f of failed) {
    lines.push(`### \`${f.name}@${f.version}\`${f.errorCode ? ` — \`${f.errorCode}\`` : ''}`);
    if (f.errorHint) { lines.push('', `**${f.errorHint}**`); }
    lines.push('', '```', f.error.slice(0, 2000), '```', '');
  }
  return lines.join('\n');
}

export default defineCommand({
  id: 'release:deliver',
  description: 'Verify and deliver the exact tarballs in a sealed candidate bundle to the configured registry',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<DeliverFlags>): Promise<CommandResult<DeliverPayload>> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const fileConfig = await useConfig<ReleaseConfig>();
      const baseConfig: ReleaseConfig = fileConfig ?? {};

      const flowResult = resolveFlowName(baseConfig, flags);
      if (typeof flowResult !== 'string') {
        const msg = `release:deliver ${flowResult.error}`;
        return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: msg, hint: 'Check the release flow configuration, then rerun `kb release artifact publish`.' } };
      }
      const config: ReleaseConfig = mergeConfigWithFlow(baseConfig, flowResult);

      const dryRun = flags['dry-run'];
      const npmTag = flags.tag ?? resolvePublishTag(config, 'stable');
      const registry = flags.registry ?? resolvePublishRegistry(config, 'stable');

      const bundleDir = resolve(repoRoot, flags['bundle-dir'] ?? '.kb/release/bundle');
      const expectedDigest = flags['expected-digest'];
      const candidateId = flags['candidate-id'];
      const commit = flags.commit;
      const version = flags.version;
      if (!expectedDigest || !candidateId || !commit || !version) {
        return {
          ok: false,
          error: {
            code: 'KB_RUNTIME_INPUT_INVALID',
            message: 'Candidate delivery requires the hosted bundle digest and expected candidate identity.',
            hint: 'Read candidateId, commit, flow, version, and bundleDigest from the hosted build run summary, then pass them as --candidate-id, --commit, --flow, --version, and --expected-digest.',
          },
        };
      }
      const trust = { expectedDigest, candidateId, commit, flow: flowResult, version };
      let candidate: ReturnType<typeof verifyCandidateBundle>;
      try {
        candidate = verifyCandidateBundle(bundleDir, trust);
      } catch (error) {
        if (!(error instanceof CandidateBundleError)) throw error;
        const command = `kb release artifact publish --flow ${flowResult} --bundle-dir "${bundleDir}" --expected-digest "${expectedDigest}" --candidate-id "${candidateId}" --commit "${commit}" --version "${version}" --registry "${registry}" --json`;
        return {
          ok: false,
          error: {
            code: 'KB_RUNTIME_INPUT_INVALID',
            message: error.message,
            hint: `Download the complete candidate bundle from its hosted build, then retry with: ${command}`,
          },
        };
      }

      const packages: PackageToPublish[] = candidate.artifacts.map(a => ({
        name: a.name,
        version: a.version,
        path: candidate.artifactsDir,
        tarballPath: join(candidate.artifactsDir, a.tarball),
      }));

      const publishLoader = useLoader(`Delivering ${packages.length} package(s) to ${registry}...`);
      publishLoader.start();

      // Publishing pre-built tarballs via `npm publish <tarball>` specifically
      // (not pnpm/yarn) — these were packed with `npm pack` in `release
      // stage`, and npm's tarball-argument publish is the well-established
      // path; no need to introduce pnpm/yarn tarball-publish behavior here.
      const publishResult = await publishPackagesProgrammatic({
        packages,
        packageManager: 'npm',
        dryRun,
        otp: flags.otp,
        tag: npmTag,
        access: (flags.access as 'public' | 'restricted' | undefined) ?? config.publish?.access,
        registry,
      });

      const conflict = publishResult.results.find(result => result.alreadyPublished);
      if (conflict) {
        publishLoader.fail(`Immutable version already exists: ${conflict.name}@${conflict.version}`);
        const error = createValidatedErrorEnvelope('KB_RELEASE_VERSION_CONFLICT', {
          templateValues: { package: conflict.name, version: conflict.version },
          hint: `Build a new higher-version candidate with kb release plan --flow ${flowResult} --channel canary --bump patch --json, then deliver its bundle using the digest and identity values in the hosted build run summary.`,
        });
        return { ok: false, error };
      }

      const failed = publishResult.results.filter(r => !r.success);
      if (publishResult.failed.length > 0) {
        publishLoader.fail(`${publishResult.failed.length} package(s) failed to publish`);
        const publishedList = publishResult.results.filter(r => r.success).map(r => ({ name: r.name, version: r.version }));
        const failedList: DeliverFailure[] = packages
          .filter(pkg => publishResult.failed.includes(`${pkg.name}@${pkg.version}`))
          .map(pkg => {
            const failure = failed.find(result => result.name === pkg.name && result.version === pkg.version);
            return {
              name: pkg.name,
              version: pkg.version,
              error: failure?.error ?? publishResult.errors[0] ?? 'Registry rejected package delivery',
              errorCode: failure?.errorCode,
              errorHint: failure?.errorHint,
            };
          });
        const result: DeliverPayload = { success: false, registry, published: publishedList, failed: failedList };

        writeGithubStepSummary(buildFailureSummaryMarkdown(registry, publishedList.length, failedList));

        const retryCommand = `kb release artifact publish --flow ${flowResult} --bundle-dir "${bundleDir}" --expected-digest "${expectedDigest}" --candidate-id "${candidateId}" --commit "${commit}" --version "${version}" --registry "${registry}" --json`;
        const firstFailure = failedList[0];
        const message = firstFailure
          ? `Delivery to ${registry} failed for ${firstFailure.name}@${firstFailure.version}${firstFailure.errorCode ? ` (${firstFailure.errorCode})` : ''}`
          : `Delivery to ${registry} failed for ${publishResult.failed.length} package(s)`;
        const recovery = firstFailure?.errorCode === 'E401'
          ? `Configure registry credentials with \`npm adduser --registry "${registry}" --auth-type=legacy\` or NPM_TOKEN/NODE_AUTH_TOKEN.`
          : firstFailure?.errorHint ?? 'Check registry access and the candidate package details.';
        const response = { ok: false as const, error: { code: 'KB_RUNTIME_COMMAND_FAILED' as const, message, hint: `${recovery} Then retry with: ${retryCommand}` } };
        if (!flags.json) {
          ctx.ui?.sideBox?.({
            title: `Deliver — ${registry}`,
            sections: [{
              header: `Failed (${publishedList.length} delivered ok)`,
              items: failedList.map(r => `${ctx.ui.symbols.error} ${r.name}@${r.version}${r.errorCode ? ` [${r.errorCode}]` : ''} — ${r.errorHint ?? 'Registry rejected this package.'}`),
            }],
            status: 'error',
          });
        }
        return response;
      }
      publishLoader.succeed(`Delivered ${publishResult.results.length} package(s) to ${registry}`);

      if (dryRun) {
        const result: DeliverPayload = { success: true, registry, published: publishResult.results.map(r => ({ name: r.name, version: r.version })) };
        return result;
      }

      // Post-delivery verification against the real registry — this is the
      // gap `release stable publish` always had (it never verified anything after
      // publishing). Real npm has propagation lag Verdaccio doesn't, hence
      // the retry budget here instead of a single-shot check.
      const verifyLoader = useLoader('Verifying delivery against the registry...');
      verifyLoader.start();
      const verifyTargets: PublishablePackage[] = candidate.artifacts.map(a => ({ name: a.name, version: a.version, path: candidate.artifactsDir }));
      const verifyResults = await verifyAgainstRegistry(verifyTargets, {
        registry,
        retries: REGISTRY_VERIFY_RETRIES,
        visibilityDeadlineMs: REGISTRY_VISIBILITY_DEADLINE_MS,
        logger: ctx.platform?.logger,
      });
      const verifyIssues = verifyResults.flatMap(r => r.issues);

      const result: DeliverPayload = {
        success: verifyIssues.length === 0,
        registry,
        published: publishResult.results.map(r => ({ name: r.name, version: r.version })),
        verifyIssues,
      };

      if (verifyIssues.length > 0) {
        // The publish already succeeded and is live — never attempt
        // npm unpublish here. Surface loudly and let a human decide.
        verifyLoader.fail(`Delivery verification found ${verifyIssues.length} issue(s) — packages are published, verification failed`);
        writeGithubStepSummary([
        `## ⚠️ \`release artifact publish --registry ${registry}\` — publish succeeded, verification found ${verifyIssues.length} issue(s)`,
          '',
          'Packages are already live on the registry — this is a verification problem, not a publish failure, and nothing was rolled back (npm unpublish is never attempted automatically).',
          '',
          ...verifyIssues.map(i => `- ${i}`),
        ].join('\n'));
      } else {
        verifyLoader.succeed('Delivery verified against the registry');
      }

      if (flags.json) {
        const response = verifyIssues.length === 0
          ? result
          : { ok: false as const, error: { code: 'KB_RUNTIME_COMMAND_FAILED' as const, message: `Delivery verification to ${registry} failed after publish completed`, hint: `Packages are already in the registry; inspect verification issues, then retry with: kb release artifact publish --flow ${flowResult} --bundle-dir "${bundleDir}" --expected-digest "${expectedDigest}" --candidate-id "${candidateId}" --commit "${commit}" --version "${version}" --registry "${registry}" --json` } };
        return response;
      }

      ctx.ui?.sideBox?.({
        title: `Deliver — ${registry}`,
        sections: [
          { header: `Delivered to ${registry} (tag: ${npmTag})`, items: publishResult.results.map(r => `${ctx.ui.symbols.success} ${r.name}@${r.version}`) },
          ...(verifyIssues.length > 0 ? [{ header: 'Verification issues', items: verifyIssues.map(i => `${ctx.ui.symbols.error} ${i}`) }] : []),
        ],
        status: verifyIssues.length === 0 ? 'success' : 'error',
      });

      return verifyIssues.length === 0
        ? result
          : { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: `Delivery verification to ${registry} failed`, hint: `Packages are already in the registry; inspect verification issues, then retry with: kb release artifact publish --flow ${flowResult} --bundle-dir "${bundleDir}" --expected-digest "${expectedDigest}" --candidate-id "${candidateId}" --commit "${commit}" --version "${version}" --registry "${registry}" --json` } };
    },
  },
});
