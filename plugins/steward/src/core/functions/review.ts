import { COLLECTIONS, type Commitment, type Project } from '../../contracts/index.js';
import { getDb } from '../db.js';
import { isStale, listCommitments } from './commitment.js';
import { appendEvent, listEvents } from './event.js';

export interface DailyReview {
  generatedAt: number;
  lastBackupDaysAgo: number | null;
  staleCommitments: Commitment[];
  upcomingCommitments: Commitment[];
  activeProjects: Project[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Summary for the daily cron artifact and the `steward review show` command.
 * First field is `lastBackupDaysAgo` on purpose (ADR-0001 §Артефакты) — a
 * silent backup failure must be the loudest line, not a swallowed log.
 */
export async function getDailyReview(): Promise<DailyReview> {
  const docs = await getDb();
  const now = Date.now();

  const [allOpen, activeProjects, exportEvents] = await Promise.all([
    listCommitments({ status: 'open', staleOnly: false }),
    docs.find<Project>(COLLECTIONS.projects, { status: 'active' }),
    listEvents({ kind: 'export.completed' }),
  ]);

  const staleCommitments = allOpen.filter((c) => isStale(c, now));
  const upcomingCommitments = allOpen
    .filter((c) => !isStale(c, now) && c.remindAt && c.remindAt - now < 7 * DAY_MS)
    .sort((a, b) => (a.remindAt ?? 0) - (b.remindAt ?? 0));

  const lastBackup = exportEvents[0];
  const lastBackupDaysAgo = lastBackup ? Math.floor((now - lastBackup.at) / DAY_MS) : null;

  const review: DailyReview = {
    generatedAt: now,
    lastBackupDaysAgo,
    staleCommitments,
    upcomingCommitments,
    activeProjects,
  };

  await appendEvent({
    subjectType: 'project',
    subjectId: 'global',
    kind: 'review.generated',
    meta: { staleCount: staleCommitments.length, upcomingCount: upcomingCommitments.length },
  });

  return review;
}

export interface IntegrityReport {
  checkedAt: number;
  counts: Record<string, number>;
  previousCounts: Record<string, number> | null;
  suspiciousDrops: string[];
}

/**
 * Flags collections whose document count dropped >20% day-over-day without
 * an explicit bulk delete — surfaced in review, not swallowed in a log
 * (ADR-0001 §Бэкапы).
 */
export async function checkIntegrity(): Promise<IntegrityReport> {
  const docs = await getDb();
  const collectionNames = Object.values(COLLECTIONS);

  const counts: Record<string, number> = {};
  for (const name of collectionNames) {
    counts[name] = await docs.count(name, {});
  }

  const [previous] = await listEvents({ kind: 'integrity.checked' });
  const previousCounts = (previous?.meta?.counts as Record<string, number> | undefined) ?? null;

  const suspiciousDrops: string[] = [];
  if (previousCounts) {
    for (const name of collectionNames) {
      const prev = previousCounts[name] ?? 0;
      const curr = counts[name] ?? 0;
      if (prev > 0 && curr < prev * 0.8) {suspiciousDrops.push(name);}
    }
  }

  const report: IntegrityReport = {
    checkedAt: Date.now(),
    counts,
    previousCounts,
    suspiciousDrops,
  };

  await appendEvent({
    subjectType: 'project',
    subjectId: 'global',
    kind: 'integrity.checked',
    meta: { counts },
  });

  return report;
}
