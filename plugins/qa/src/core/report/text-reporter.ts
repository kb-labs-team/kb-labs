import type {
  RunSnapshot,
  CheckSnapshot,
  StatsSnapshot,
  TrendAnalysis,
  RegressionDetection,
  BaselineData,
  BaselineCheckDiff,
} from '../../contracts/index.js';

export interface ReportSection {
  header: string;
  lines: string[];
}

export function formatTaskName(task: string): string {
  return task
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function buildRunReport(snap: RunSnapshot | null): ReportSection[] {
  if (!snap) {return [{ header: 'Run', lines: ['No run data available.'] }];}

  const sections: ReportSection[] = [];
  const tasks = [...new Set(snap.raw.results.map(r => r.Task))];

  for (const task of tasks) {
    const results = snap.raw.results.filter(r => r.Task === task);
    const passed = results.filter(r => r.OK && !r.Cached).length;
    const failed = results.filter(r => !r.OK && !r.Cached).length;
    const cached = results.filter(r => r.Cached).length;
    const failedPkgs = results.filter(r => !r.OK && !r.Cached).map(r => r.Package);

    const lines: string[] = [`pass ${passed}  fail ${failed}  cached ${cached}`];
    if (failedPkgs.length > 0) {
      const shown = failedPkgs.slice(0, 5);
      lines.push(...shown.map(p => `  ✗ ${p}`));
      if (failedPkgs.length > 5) {lines.push(`  ... ${failedPkgs.length - 5} more`);}
    }

    sections.push({ header: formatTaskName(task), lines });
  }

  const status = snap.raw.ok ? 'passed' : 'failed';
  const { total, passed: p, failed: f, cached: c } = snap.raw.summary;
  sections.push({
    header: 'Summary',
    lines: [`${status.toUpperCase()}  total ${total}  pass ${p}  fail ${f}  cached ${c}  (${snap.raw.elapsed})`],
  });

  return sections;
}

export function buildCheckReport(snap: CheckSnapshot | null): ReportSection[] {
  if (!snap) {return [{ header: 'Check', lines: ['No check data available.'] }];}

  const sections: ReportSection[] = [];

  for (const [pkg, pkgData] of Object.entries(snap.raw.packages)) {
    const issues = pkgData.issues ?? [];
    if (issues.length === 0) {continue;}

    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    const infos = issues.filter(i => i.severity === 'info').length;

    const lines: string[] = [`errors ${errors}  warnings ${warnings}  info ${infos}`];
    for (const issue of issues.slice(0, 5)) {
      lines.push(`  [${issue.severity}] ${issue.check}: ${issue.message}`);
    }
    if (issues.length > 5) {lines.push(`  ... ${issues.length - 5} more`);}

    sections.push({ header: pkg, lines });
  }

  if (sections.length === 0) {
    sections.push({ header: 'Check', lines: ['All packages OK.'] });
  }

  return sections;
}

export function buildStatsReport(snap: StatsSnapshot | null): ReportSection[] {
  if (!snap) {return [{ header: 'Stats', lines: ['No stats data available.'] }];}

  const { score, grade, summary, by_category, coverage } = snap.raw;

  const sections: ReportSection[] = [];

  sections.push({
    header: 'Score',
    lines: [`${score}/100  Grade: ${grade}  (${summary.healthy} healthy / ${summary.warning} warning / ${summary.error} error)`],
  });

  const catLines = Object.entries(by_category).map(([cat, data]) => {
    const pct = data.total > 0 ? Math.round((data.healthy / data.total) * 100) : 0;
    return `  ${cat.padEnd(20)} ${data.grade}  ${pct}%  (${data.healthy}/${data.total})`;
  });
  sections.push({ header: 'By Category', lines: catLines });

  if (Object.keys(coverage).length > 0) {
    const covLines = Object.entries(coverage).map(([k, v]) => `  ${k.padEnd(20)} ${v.pct}%  (${v.pass}/${v.total})`);
    sections.push({ header: 'Coverage', lines: covLines });
  }

  return sections;
}

export function buildHistoryTable(history: RunSnapshot[], limit = 20): ReportSection[] {
  const rows = [...history].reverse().slice(0, limit);
  if (rows.length === 0) {return [{ header: 'History', lines: ['No history available.'] }];}

  const lines = rows.map(snap => {
    const status = snap.raw.ok ? 'pass' : 'fail';
    const tasks = snap.tasks.join(', ');
    const commit = snap.git?.commit ?? '-------';
    const date = new Date(snap.timestamp).toLocaleString();
    return `  ${date}  ${commit}  ${status}  [${tasks}]`;
  });

  return [{ header: `History (last ${rows.length})`, lines }];
}

export function buildTrendsReport(analysis: TrendAnalysis): ReportSection[] {
  if (analysis.tasks.length === 0) {
    return [{ header: 'Trends', lines: ['Not enough history for trend analysis.'] }];
  }

  const sections: ReportSection[] = [];

  for (const trend of analysis.tasks) {
    const arrow = trend.direction === 'regression' ? '↑' : trend.direction === 'improvement' ? '↓' : '→';
    const lines: string[] = [
      `${arrow} ${trend.direction}  prev ${trend.previous}  curr ${trend.current}  delta ${trend.delta > 0 ? '+' : ''}${trend.delta}  velocity ${trend.velocity}`,
    ];

    if (trend.changelog.length > 0) {
      const last = trend.changelog[trend.changelog.length - 1]!;
      if (last.newFailures.length > 0) {lines.push(`  last regression: ${last.newFailures.slice(0, 3).join(', ')}`);}
      if (last.fixed.length > 0) {lines.push(`  last fixed: ${last.fixed.slice(0, 3).join(', ')}`);}
    }

    sections.push({ header: formatTaskName(trend.task), lines });
  }

  return sections;
}

export function buildRegressionsReport(detection: RegressionDetection): ReportSection[] {
  if (!detection.hasRegressions) {
    return [{ header: 'Regressions', lines: ['No regressions detected.'] }];
  }

  const sections: ReportSection[] = [];

  for (const reg of detection.regressions) {
    const lines = [
      `delta +${reg.delta}`,
      ...reg.newFailures.slice(0, 5).map(p => `  ✗ ${p}`),
    ];
    if (reg.newFailures.length > 5) {lines.push(`  ... ${reg.newFailures.length - 5} more`);}
    sections.push({ header: formatTaskName(reg.task), lines });
  }

  const prev = new Date(detection.comparedAt.previous).toLocaleString();
  const curr = new Date(detection.comparedAt.current).toLocaleString();
  sections.push({ header: 'Compared', lines: [`${prev} → ${curr}`] });

  return sections;
}

export function buildBaselineReport(baseline: BaselineData | null): ReportSection[] {
  if (!baseline) {return [{ header: 'Baseline', lines: ['No baseline set. Run `qa baseline update` to set one.'] }];}

  const { score, grade } = baseline.stats;
  const totalIssues = Object.values(baseline.check.packages)
    .reduce((sum, pkg) => sum + (pkg.issues?.length ?? 0), 0);
  const commit = baseline.git?.commit ?? 'unknown';
  const date = new Date(baseline.timestamp).toLocaleString();

  return [{
    header: 'Baseline',
    lines: [`score ${score}/100  grade ${grade}  issues ${totalIssues}  commit ${commit}  set ${date}`],
  }];
}

export function buildBaselineDiffReport(diff: BaselineCheckDiff): ReportSection[] {
  const sections: ReportSection[] = [];

  const scoreDir = diff.scoreDelta > 0 ? '+' : '';
  sections.push({
    header: 'Score Delta',
    lines: [`${scoreDir}${diff.scoreDelta}  ${diff.gradeDelta}  new ${diff.newIssueCount}  fixed ${diff.fixedIssueCount}`],
  });

  if (diff.newIssues.length > 0) {
    const lines = diff.newIssues.slice(0, 10).map(i => `  [${i.severity}] ${i.pkg}  ${i.check}: ${i.message}`);
    if (diff.newIssues.length > 10) {lines.push(`  ... ${diff.newIssues.length - 10} more`);}
    sections.push({ header: 'New Issues', lines });
  }

  if (diff.fixedIssues.length > 0) {
    const lines = diff.fixedIssues.slice(0, 10).map(i => `  [${i.severity}] ${i.pkg}  ${i.check}: ${i.message}`);
    if (diff.fixedIssues.length > 10) {lines.push(`  ... ${diff.fixedIssues.length - 10} more`);}
    sections.push({ header: 'Fixed Issues', lines });
  }

  if (diff.persistingIssues.length > 0) {
    sections.push({ header: 'Persisting Issues', lines: [`${diff.persistingIssues.length} issues unchanged`] });
  }

  return sections;
}
