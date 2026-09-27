#!/usr/bin/env node
// Step: Functional Verification
// Env: ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY
import { writeFileSync, mkdirSync } from 'node:fs';
import { workspaceRoot, runOut, readFileOrEmpty, callClaude, parseKbOutputLine, emitKbOutput } from './lib/kb.mjs';

process.chdir(workspaceRoot());

const { ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY } = process.env;
const artifactsDir = '.kb/run-artifacts';
mkdirSync(artifactsDir, { recursive: true });

const plan = readFileOrEmpty('PLAN.md');
const changedFiles = runOut('git', ['diff', '--name-only', 'HEAD']);
const cwd = process.cwd();

const prompt = `You are a developer who just received a PR implementing this feature. Your job is to verify it actually works — the same way you would manually check it before approving. Write everything in English.

IMPORTANT SECURITY RULE: Never quote, print, or include the literal value of any secret, token, password, or credential in your output — even if you find one in a file. Describe the problem without revealing the value.

Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

Issue description:
${ISSUE_BODY}

Implementation plan:
${plan}

Changed files:
${changedFiles}

Working directory: ${cwd}

## Rules

1. DO NOT run unit tests or type-check — those run separately. This step is about real behavior.
2. Simulate a human developer trying the feature from scratch.
3. Use the actual end-user CLI commands (kb workflow ..., kb agent ..., etc.) or HTTP endpoints.
4. If a service is not running, start it first — do not skip the criterion because of this.
5. Observe REAL output. If the command errors, crashes, hangs, or produces wrong output → FAIL.
6. A criterion PASSES only if you see the actual expected output with your own eyes.

## Step 1 — Ensure services are up

Check if required services are running (curl their /health endpoints).
If not running, start them:
  node ${cwd}/plugins/workflow/daemon/dist/bin.js &
  (wait 3s, then verify /health returns ok)

Or use kb-dev if available:
  kb-dev start --config .kb/devservices.dev.yaml

## Step 2 — Derive acceptance criteria from the issue

Extract 3-6 concrete criteria. Each must be verifiable by running a real command and observing its output. Think: what would you type in the terminal to confirm this feature works?

Examples:
- "Running 'kb workflow runs watch <id>' shows step names like '[Check CI]' not UUIDs"
- "Running 'kb workflow runs watch <id> --logs' shows only log lines, no status events"
- NOT: "unit tests pass" — that is not a criterion here

## Step 3 — Run each criterion

For each criterion:
1. Print the criterion
2. Print the exact command you are running
3. Run it and capture real output
4. Print the actual output (truncate to 500 chars if long)
5. Mark: PASS / FAIL / SKIP (with reason)

FAIL if: command exits non-zero, output is empty when content expected, output shows error/exception, feature doesn't behave as described.

## Step 4 — Output the report

## Functional Verification Report
**Issue**: #${ISSUE_NUMBER} — ${ISSUE_TITLE}

### AC-1: <criterion>
\`\`\`
$ <command>
<actual output>
\`\`\`
**Result**: PASS | FAIL | SKIP

### AC-2: ...

## Verdict
PASSED | FAILED
**Summary**: (1-2 sentences — what you ran, what you saw, whether it works)

At the very end output exactly one line:
::kb-output::{"verdict":"PASSED"|"FAILED","criteria_total":N,"criteria_passed":N}`;

const res = callClaude({ prompt, outputFormat: 'text', noSessionPersistence: true });
const report = res.stdout;

writeFileSync(`${artifactsDir}/functional-verification-${ISSUE_NUMBER}.md`, report);
// Print report without its embedded ::kb-output:: line — our own line below is authoritative
console.log(report.split('\n').filter((l) => !l.startsWith('::kb-output::')).join('\n'));

const parsed = parseKbOutputLine(report) || {};
const verdict = parsed.verdict === 'PASSED' ? 'PASSED' : 'FAILED';
const criteriaTotal = Number(parsed.criteria_total) || 0;
const criteriaPassed = Number(parsed.criteria_passed) || 0;

emitKbOutput({ verdict, criteria_total: criteriaTotal, criteria_passed: criteriaPassed, report: report.slice(-2000) });
