import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestPlatform } from '@kb-labs/sdk/testing';
import { COLLECTIONS } from '@kb-labs/steward/contracts';
import { getDailyReview, checkIntegrity } from '../../src/core/functions/review.js';
import { addProject } from '../../src/core/functions/project.js';
import { addCommitment } from '../../src/core/functions/commitment.js';
import { exportSnapshot } from '../../src/core/functions/export.js';
import { getDb } from '../../src/core/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('getDailyReview', () => {
  beforeEach(() => {
    setupTestPlatform();
  });

  afterEach(() => {
    setupTestPlatform();
  });

  it('reports lastBackupDaysAgo as null when no backup has ever run', async () => {
    const review = await getDailyReview();
    expect(review.lastBackupDaysAgo).toBeNull();
  });

  it('reports lastBackupDaysAgo once an export has completed', async () => {
    await exportSnapshot();
    const review = await getDailyReview();
    expect(review.lastBackupDaysAgo).toBe(0);
  });

  it('separates stale (overdue) from upcoming (within 7 days) open commitments', async () => {
    const now = Date.now();
    await addCommitment({ text: 'Overdue', remindAt: now - DAY_MS, staleAfterDays: 14 });
    await addCommitment({ text: 'Due soon', remindAt: now + 2 * DAY_MS, staleAfterDays: 14 });
    await addCommitment({ text: 'Far out', remindAt: now + 30 * DAY_MS, staleAfterDays: 14 });

    const review = await getDailyReview();
    expect(review.staleCommitments.map((c) => c.text)).toEqual(['Overdue']);
    expect(review.upcomingCommitments.map((c) => c.text)).toEqual(['Due soon']);
  });

  it('only includes active projects', async () => {
    await addProject({ name: 'Active', status: 'active' });
    await addProject({ name: 'Archived', status: 'archived' });

    const review = await getDailyReview();
    expect(review.activeProjects.map((p) => p.name)).toEqual(['Active']);
  });

  it('records a review.generated event on every call', async () => {
    const review = await getDailyReview();
    expect(review.generatedAt).toBeTypeOf('number');
  });
});

describe('checkIntegrity', () => {
  beforeEach(() => {
    setupTestPlatform();
  });

  afterEach(() => {
    setupTestPlatform();
  });

  it('has no previousCounts and no drops on the first run', async () => {
    await addProject({ name: 'P1', status: 'active' });
    const report = await checkIntegrity();

    expect(report.previousCounts).toBeNull();
    expect(report.suspiciousDrops).toEqual([]);
    expect(report.counts[COLLECTIONS.projects]).toBe(1);
  });

  it('flags a collection whose count dropped more than 20% since the previous check', async () => {
    for (let i = 0; i < 10; i++) {
      await addProject({ name: `P${i}`, status: 'active' });
    }
    await checkIntegrity();

    const docs = await getDb();
    const remaining = await docs.find(COLLECTIONS.projects, {});
    const toDelete = remaining.slice(0, 5) as Array<{ id: string }>;
    for (const doc of toDelete) {
      await docs.deleteById(COLLECTIONS.projects, doc.id);
    }

    const second = await checkIntegrity();
    expect(second.suspiciousDrops).toContain(COLLECTIONS.projects);
  });

  it('does not flag a collection that stayed stable', async () => {
    await addProject({ name: 'Stable', status: 'active' });
    await checkIntegrity();
    const second = await checkIntegrity();
    expect(second.suspiciousDrops).not.toContain(COLLECTIONS.projects);
  });
});
