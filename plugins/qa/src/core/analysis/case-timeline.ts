import type {
  E2eFlakySnapshot,
  E2eCaseResult,
  E2eErrorCategory,
  CaseHistoryEntry,
  CaseTimeline,
  FlakyOverview,
  FlakyOverviewEntry,
} from '../../contracts/index.js';
import { TRENDS_WINDOW } from '../../contracts/index.js';

export function caseKeyOf(caseResult: Pick<E2eCaseResult, 'suite' | 'spec' | 'testId'>): string {
  return `${caseResult.suite}/${caseResult.spec}#${caseResult.testId}`;
}

function lastErrorOf(caseResult: E2eCaseResult): { category?: E2eErrorCategory; message?: string } {
  const failedAttempt = [...caseResult.attempts].reverse().find(a => a.status === 'failed');
  return { category: failedAttempt?.errorCategory, message: failedAttempt?.errorMessage };
}

export function buildCaseTimeline(
  history: E2eFlakySnapshot[],
  caseKey: string,
): CaseTimeline | null {
  const entries: CaseHistoryEntry[] = [];
  let suite = '';
  let spec = '';
  let testId = '';
  let title = '';

  for (const snap of [...history].reverse()) {
    const match = snap.cases.find(c => caseKeyOf(c) === caseKey);
    if (!match) {continue;}
    suite = match.suite;
    spec = match.spec;
    testId = match.testId;
    title = match.title;
    const { category, message } = lastErrorOf(match);
    entries.push({
      timestamp: snap.timestamp,
      gitCommit: snap.git?.commit ?? 'unknown',
      status: match.outcome,
      retries: match.attempts.length > 0 ? match.attempts.length - 1 : 0,
      errorCategory: category,
      errorMessage: message,
    });
  }

  if (entries.length === 0) {return null;}

  const nonSkipped = entries.filter(e => e.status !== 'skipped');
  let flips = 0;
  for (let i = 1; i < nonSkipped.length; i++) {
    if (nonSkipped[i]!.status !== nonSkipped[i - 1]!.status) {flips++;}
  }
  const flakyScore = nonSkipped.length > 1
    ? Math.round((flips / (nonSkipped.length - 1)) * 100) / 100
    : 0;

  // Uses nonSkipped (not entries) so a run of 'skipped' outcomes doesn't
  // fabricate a passing streak — same exclusion flakyScore applies above.
  const latest = nonSkipped[0];
  let streakStatus: 'passing' | 'failing' = 'passing';
  let streakCount = 0;
  if (latest) {
    streakStatus = latest.status === 'failed' ? 'failing' : 'passing';
    streakCount = 1;
    for (let i = 1; i < nonSkipped.length; i++) {
      const s = nonSkipped[i]!.status === 'failed' ? 'failing' : 'passing';
      if (s !== streakStatus) {break;}
      streakCount++;
    }
  }

  let firstFailure: string | undefined;
  for (const e of [...entries].reverse()) {
    if (e.status === 'failed' || e.status === 'flaky') {
      firstFailure = e.timestamp;
      break;
    }
  }

  return {
    caseKey,
    suite,
    spec,
    testId,
    title,
    history: entries,
    flakyScore,
    currentStreak: { status: streakStatus, count: streakCount },
    firstFailure,
  };
}

export function analyzeFlakyCases(
  history: E2eFlakySnapshot[],
  window: number = TRENDS_WINDOW,
): FlakyOverview {
  const windowSnaps = history.slice(-window);
  if (windowSnaps.length === 0) {
    return {
      window,
      runsAnalyzed: 0,
      totalCases: 0,
      flakyCases: 0,
      delta: { new: [], fixed: [], unchanged: [] },
      byCategory: { 'infra-timeout': 0, 'assertion-race': 0, 'ws-flake': 0, unknown: 0 },
      top: [],
    };
  }

  const caseKeys = new Set<string>();
  for (const snap of windowSnaps) {
    for (const c of snap.cases) {caseKeys.add(caseKeyOf(c));}
  }

  const byCategory: Record<E2eErrorCategory, number> = {
    'infra-timeout': 0,
    'assertion-race': 0,
    'ws-flake': 0,
    unknown: 0,
  };
  const flakyEntries: FlakyOverviewEntry[] = [];
  const flakyNowKeys = new Set<string>();

  for (const key of caseKeys) {
    const timeline = buildCaseTimeline(windowSnaps, key);
    if (!timeline || timeline.flakyScore === 0) {continue;}

    flakyNowKeys.add(key);
    const category = timeline.history[0]?.errorCategory ?? 'unknown';
    byCategory[category]++;
    flakyEntries.push({
      case: key,
      flakyScore: timeline.flakyScore,
      streak: `${timeline.currentStreak.status} x${timeline.currentStreak.count}`,
      category,
    });
  }

  flakyEntries.sort((a, b) => b.flakyScore - a.flakyScore);

  const previousSnaps = history.slice(-2 * window, -window);
  // Collect previous-window keys independently of `caseKeys` (current window)
  // — a case that was flaky before but has since disappeared entirely (spec
  // renamed/deleted) must still be checkable, or it can never show up as "fixed".
  const previousCaseKeys = new Set<string>();
  for (const snap of previousSnaps) {
    for (const c of snap.cases) {previousCaseKeys.add(caseKeyOf(c));}
  }
  const flakyPreviousKeys = new Set<string>();
  for (const key of previousCaseKeys) {
    const timeline = buildCaseTimeline(previousSnaps, key);
    if (timeline && timeline.flakyScore > 0) {flakyPreviousKeys.add(key);}
  }

  const delta = {
    new: [...flakyNowKeys].filter(k => !flakyPreviousKeys.has(k)),
    fixed: [...flakyPreviousKeys].filter(k => !flakyNowKeys.has(k)),
    unchanged: [...flakyNowKeys].filter(k => flakyPreviousKeys.has(k)),
  };

  return {
    window,
    runsAnalyzed: windowSnaps.length,
    totalCases: caseKeys.size,
    flakyCases: flakyNowKeys.size,
    delta,
    byCategory,
    top: flakyEntries.slice(0, 5),
  };
}
