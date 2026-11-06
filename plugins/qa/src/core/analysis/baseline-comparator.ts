import type {
  BaselineData,
  BaselineCheckDiff,
  CheckIssueDiff,
  DevkitCheckOutput,
  DevkitStatsOutput,
} from '../../contracts/index.js';

function issueKey(pkg: string, check: string, message: string): string {
  return `${pkg}::${check}::${message}`;
}

export function compareWithBaseline(
  currentCheck: DevkitCheckOutput,
  currentStats: DevkitStatsOutput,
  baseline: BaselineData,
): BaselineCheckDiff {
  const baselineIssues = new Map<string, CheckIssueDiff>();
  for (const [pkg, pkgData] of Object.entries(baseline.check.packages)) {
    for (const issue of pkgData.issues ?? []) {
      const key = issueKey(pkg, issue.check, issue.message);
      baselineIssues.set(key, {
        pkg, check: issue.check, status: 'fixed', severity: issue.severity, message: issue.message,
      });
    }
  }

  const currentIssues = new Map<string, CheckIssueDiff>();
  for (const [pkg, pkgData] of Object.entries(currentCheck.packages)) {
    for (const issue of pkgData.issues ?? []) {
      const key = issueKey(pkg, issue.check, issue.message);
      currentIssues.set(key, {
        pkg, check: issue.check, status: 'new', severity: issue.severity, message: issue.message,
      });
    }
  }

  const newIssues: CheckIssueDiff[] = [];
  const fixedIssues: CheckIssueDiff[] = [];
  const persistingIssues: CheckIssueDiff[] = [];

  for (const [key, issue] of currentIssues) {
    if (baselineIssues.has(key)) {
      persistingIssues.push({ ...issue, status: 'persisting' });
    } else {
      newIssues.push({ ...issue, status: 'new' });
    }
  }
  for (const [key, issue] of baselineIssues) {
    if (!currentIssues.has(key)) {
      fixedIssues.push({ ...issue, status: 'fixed' });
    }
  }

  return {
    newIssues,
    fixedIssues,
    persistingIssues,
    newIssueCount: newIssues.length,
    fixedIssueCount: fixedIssues.length,
    scoreDelta: currentStats.score - baseline.stats.score,
    gradeDelta: `${baseline.stats.grade} → ${currentStats.grade}`,
  };
}
