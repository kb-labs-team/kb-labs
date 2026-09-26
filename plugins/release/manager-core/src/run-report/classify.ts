/**
 * Failure classification for release checks.
 *
 * Pure, ordered rules over signals we already have: the check's error message,
 * exit code and captured stdout/stderr. Precedence matters and is tested:
 *
 *   1. package-content evidence   (definitive: the tarball itself is wrong)
 *   2. CI-infrastructure evidence (disk / memory / fd exhaustion)
 *   3. environment evidence       (registry / Docker / missing plan file)
 *   4. transient network signals  -> suspected-flake
 *   5. timeout                    -> suspected-flake
 *   6. anything else              -> unknown
 *
 * Content wins over timeout/environment: if partial output of a killed process
 * already proves a broken manifest, retrying will not help. Environment wins
 * over the timeout because a dead registry is the cause, the timeout the symptom.
 */

import type { ReleaseErrorCode } from './error-codes';

export type FailureClassification =
  | 'environment'
  | 'package-content'
  | 'ci-infrastructure'
  | 'suspected-flake'
  | 'unknown';

export interface FailureSignals {
  /** CheckResultDetails.error (e.g. `exit code 1`, `Process terminated: timeout`). */
  error?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface FailureVerdict {
  classification: FailureClassification;
  code: ReleaseErrorCode;
  /** Stable rule id, useful in tests and telemetry. */
  rule: string;
  /** One-line root cause. */
  rootCause: string;
  hint: string;
  timedOut: boolean;
}

const REGISTRY_START_COMMAND = './tools/kb-dev/kb-dev ensure verdaccio --config .kb/devservices.dev.yaml --net-offset <N>';

export function isTimeoutSignal(s: FailureSignals): boolean {
  return /PROCESS_TIMEOUT|Process terminated: timeout|\btimed out\b/i.test(s.error ?? '');
}

function combined(s: FailureSignals): string {
  return [s.error, s.stderr, s.stdout].filter(Boolean).join('\n');
}

function firstMatch(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  return m ? m[0] : undefined;
}

function hasOutput(s: FailureSignals): boolean {
  return Boolean((s.stdout && s.stdout.trim()) || (s.stderr && s.stderr.trim()));
}

export function classifyFailure(signals: FailureSignals): FailureVerdict {
  const text = combined(signals);
  const timedOut = isTimeoutSignal(signals);

  // 1. package-content -------------------------------------------------------
  // scripts/gates/check-pack-install.sh: packed manifest contains workspace-only protocols.
  const protocolIssues = /workspace-only dependency protocols:\s*\n?\s*([^\n]+)/i.exec(text);
  if (protocolIssues || /EUNSUPPORTEDPROTOCOL/.test(text) || /Unsupported URL Type "workspace:/i.test(text)) {
    const detail = protocolIssues?.[1]?.trim() ?? firstMatch(text, /Unsupported URL Type "[^"]+"/i) ?? 'EUNSUPPORTEDPROTOCOL';
    return {
      classification: 'package-content',
      code: 'KB_RELEASE_CHECK_FAILED',
      rule: 'workspace-protocol',
      rootCause: `Packed manifest still contains a workspace-only dependency protocol (${detail}).`,
      hint: 'Internal dependencies must be rewritten to concrete versions before packing. Re-run `kb release stage` (dependency rewrite), then re-run checks; if it persists, fix the package.json or the rewrite step.',
      timedOut,
    };
  }

  const missingEntry = /declared entry '([^']+)' missing from packed tarball/i.exec(text);
  if (missingEntry) {
    return {
      classification: 'package-content',
      code: 'KB_RELEASE_CHECK_FAILED',
      rule: 'missing-export',
      rootCause: `Declared entry '${missingEntry[1]}' is missing from the packed tarball.`,
      hint: 'Build the package (`kb-devkit run build --affected`) and check the `files`/`exports` fields in its package.json.',
      timedOut,
    };
  }

  if (/ERR_PACKAGE_PATH_NOT_EXPORTED/.test(text)) {
    return {
      classification: 'package-content',
      code: 'KB_RELEASE_CHECK_FAILED',
      rule: 'missing-export',
      rootCause: 'A subpath is imported that the package `exports` map does not declare.',
      hint: 'Add the subpath to `exports` or stop importing it.',
      timedOut,
    };
  }

  if (/failed syntax check/i.test(text) || /SyntaxError:/.test(text)) {
    return {
      classification: 'package-content',
      code: 'KB_RELEASE_CHECK_FAILED',
      rule: 'syntax-error',
      rootCause: 'The package main entry does not pass a syntax check.',
      hint: 'Rebuild the package and inspect the entry file named in the log.',
      timedOut,
    };
  }

  const cannotImport = /clean consumer cannot import (\S+)/i.exec(text);
  if (cannotImport || /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(text)) {
    return {
      classification: 'package-content',
      code: 'KB_RELEASE_CHECK_FAILED',
      rule: 'import-failed',
      rootCause: cannotImport
        ? `A clean consumer cannot import ${cannotImport[1]}.`
        : 'A module the package needs is not resolvable from the packed artifact.',
      hint: 'Check that runtime imports are declared in `dependencies` and that the built output exists.',
      timedOut,
    };
  }

  // 2. ci-infrastructure -----------------------------------------------------
  const infra =
    firstMatch(text, /ENOSPC|no space left on device/i) ??
    firstMatch(text, /EMFILE|too many open files/i) ??
    firstMatch(text, /JavaScript heap out of memory|Cannot allocate memory|ENOMEM/i);
  if (infra || signals.exitCode === 137) {
    return {
      classification: 'ci-infrastructure',
      code: 'KB_RELEASE_CHECK_FAILED',
      rule: 'resource-exhaustion',
      rootCause: `Runner resource exhaustion (${infra ?? 'process killed with exit 137, likely out of memory'}).`,
      hint: 'Free disk/memory on the runner or lower `KB_RELEASE_CHECKS_CONCURRENCY`, then re-run.',
      timedOut,
    };
  }

  // 3. environment -----------------------------------------------------------
  // scripts/gates/check-pack-install.sh: "local staging registry unreachable at <url>".
  const registry = /staging registry unreachable at (\S+)/i.exec(text);
  if (registry) {
    return {
      classification: 'environment',
      code: 'KB_RELEASE_REGISTRY_UNREACHABLE',
      rule: 'registry-unreachable',
      rootCause: `Staging registry ${registry[1]} is unreachable; the failure is not about package content.`,
      hint: `Start it with \`${REGISTRY_START_COMMAND}\`, re-run staging so the planned versions exist there, then re-run checks.`,
      timedOut,
    };
  }

  if (/Cannot connect to the Docker daemon|docker: command not found|Is the docker daemon running/i.test(text)) {
    return {
      classification: 'environment',
      code: 'KB_RELEASE_DOCKER_UNAVAILABLE',
      rule: 'docker-unavailable',
      rootCause: 'Docker is not available to the check.',
      hint: 'Start Docker and re-run.',
      timedOut,
    };
  }

  if (/RELEASE_PLAN_PATH is set to '[^']*' but that file does not exist/i.test(text)) {
    return {
      classification: 'environment',
      code: 'KB_RELEASE_PLAN_INVALID',
      rule: 'plan-file-missing',
      rootCause: 'RELEASE_PLAN_PATH points to a file that does not exist.',
      hint: 'Re-run the plan stage so the plan file exists, or unset RELEASE_PLAN_PATH.',
      timedOut,
    };
  }

  const refused = firstMatch(text, /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/);
  if (refused) {
    return {
      classification: 'environment',
      code: 'KB_RELEASE_REGISTRY_UNREACHABLE',
      rule: 'network-refused',
      rootCause: `Network target refused or could not be resolved (${refused}).`,
      hint: 'Verify the registry/service the check talks to is running and reachable, then re-run.',
      timedOut,
    };
  }

  // 4. transient network -----------------------------------------------------
  const transient = firstMatch(text, /ECONNRESET|ETIMEDOUT|socket hang up|\bE50[023]\b|50[23] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)/i);
  if (transient) {
    return {
      classification: 'suspected-flake',
      code: timedOut ? 'KB_RELEASE_CHECK_TIMEOUT' : 'KB_RELEASE_CHECK_FAILED',
      rule: 'transient-network',
      rootCause: `Transient network error (${transient}).`,
      hint: 'Re-run the check; if it repeats on the same package, treat it as an environment problem.',
      timedOut,
    };
  }

  // 5. timeout ---------------------------------------------------------------
  if (timedOut) {
    const seen = hasOutput(signals) ? 'partial output before the kill is attached' : 'no output was captured before the kill';
    return {
      classification: 'suspected-flake',
      code: 'KB_RELEASE_CHECK_TIMEOUT',
      rule: 'timeout',
      rootCause: `Check was killed by the timeout (${seen}); no content or environment error was seen.`,
      hint: 'Often contention under concurrency. Re-run; if it times out again, lower `KB_RELEASE_CHECKS_CONCURRENCY` or raise the check `timeoutMs`.',
      timedOut,
    };
  }

  // 6. fallback --------------------------------------------------------------
  const exit = signals.exitCode !== undefined ? ` (exit code ${signals.exitCode})` : '';
  return {
    classification: 'unknown',
    code: 'KB_RELEASE_CHECK_FAILED',
    rule: 'unclassified',
    rootCause: `Check failed${exit} with no recognised cause.`,
    hint: 'Read the output excerpt and the full check log; add a classification rule if this recurs.',
    timedOut,
  };
}
