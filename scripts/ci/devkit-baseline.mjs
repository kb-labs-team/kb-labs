import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const baselinePath = 'scripts/ci/devkit-baseline.json';

export function readDevkitFindings(envelope, workspace) {
  if (envelope?.ok === false && envelope.error?.code !== 'KB_DEVKIT_STANDARDS_VIOLATIONS') {
    const heading = `DevKit execution failed (${envelope.error?.code ?? 'unknown error'})`;
    const failures = envelope.data?.checks;
    const checkResults = Array.isArray(failures) ? failures.map(failure => ({
      check: failure.check,
      exitCode: failure.exitCodeKnown ? failure.exitCode : null,
      rerunCommand: failure.rerunCommand,
    })) : [];
    throw new Error(checkResults.length ? `${heading}\n${JSON.stringify(checkResults)}` : heading);
  }
  const report = envelope?.data;
  if (typeof envelope?.ok !== 'boolean' || report?.ok !== envelope.ok ||
      !Array.isArray(report.results) || !report.results.length ||
      !(report.summary?.packagesChecked > 0) || !(report.summary?.checksRun > 0)) {
    throw new Error('Expected a complete DevKit check report');
  }

  const findings = [];
  for (const result of report.results) {
    for (const issue of result.issues ?? []) {
      if (issue.checkFailure) throw new Error(`DevKit check execution failed (${issue.check})`);
      if (issue.severity !== 'error') continue;
      const file = issue.file ?? '';
      findings.push([result.package, issue.check, isAbsolute(file) ? relative(workspace, file) : file, issue.message]);
    }
  }
  if (findings.length !== report.summary.errors || envelope.ok !== (findings.length === 0)) {
    throw new Error('Expected a complete DevKit check report with consistent finding counts');
  }
  return findings;
}

function difference(left, right) {
  const remaining = right.map((finding) => JSON.stringify(finding));
  return left.filter((finding) => {
    const index = remaining.indexOf(JSON.stringify(finding));
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

export function compareFindings(approved, snapshot, observed) {
  const checks = [
    ['Unapproved snapshot additions', difference(snapshot, approved)],
    ['New findings', difference(observed, snapshot)],
    ['Remove resolved findings from the snapshot', difference(snapshot, observed)],
  ];
  for (const [label, findings] of checks) {
    if (findings.length) throw new Error(`${label}:\n${findings.map(formatFinding).join('\n')}`);
  }
  return approved.length - observed.length;
}

function formatFinding(finding) {
  return `- ${finding.filter(Boolean).join(' | ')}`;
}

function readSnapshot(text) {
  const snapshot = JSON.parse(text);
  if (!/^[0-9a-f]{40}$/.test(snapshot.sourceSha) || !Array.isArray(snapshot.findings) ||
      !snapshot.findings.every((row) => Array.isArray(row) && row.length === 4 && row.every((part) => typeof part === 'string'))) {
    throw new Error('Invalid DevKit baseline snapshot');
  }
  return snapshot;
}

function main(reportPath, base, checkStatus) {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('Expected the exact PR base SHA');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const findings = readDevkitFindings(report, process.cwd());
  if (checkStatus !== (report.ok ? '0' : '1')) throw new Error(`Unexpected DevKit exit status ${checkStatus}`);

  const proposed = readSnapshot(readFileSync(baselinePath, 'utf8'));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const hasApproved = git('ls-tree', base, '--', baselinePath).length > 0;
  const approved = hasApproved ? readSnapshot(git('show', `${base}:${baselinePath}`)) : proposed;
  if (proposed.sourceSha !== (hasApproved ? approved.sourceSha : base)) {
    throw new Error('DevKit baseline does not match its approved source SHA');
  }

  const recovered = compareFindings(approved.findings, proposed.findings, findings);
  console.log(`DevKit standards on the proposed merge. ${findings.length} inherited, ${recovered} recovered, 0 new.`);
  for (const finding of findings) console.log(formatFinding(finding));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(...process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
