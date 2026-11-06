import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestPlatform } from '@kb-labs/sdk/testing';
import type { Commitment } from '@kb-labs/steward/contracts';
import {
  isStale,
  addCommitment,
  listCommitments,
  commitmentDone,
  commitmentDrop,
  commitmentSnooze,
} from '../../src/core/functions/commitment.js';
import { listEvents } from '../../src/core/functions/event.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeCommitment(overrides: Partial<Commitment>): Commitment {
  return {
    id: 'cmt_1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    text: 'do the thing',
    status: 'open',
    staleAfterDays: 14,
    ...overrides,
  };
}

describe('commitment functions', () => {
  beforeEach(() => {
    setupTestPlatform();
  });

  afterEach(() => {
    setupTestPlatform();
  });

  describe('isStale', () => {
    it('is never stale once resolved', () => {
      const c = makeCommitment({ status: 'done', createdAt: Date.now() - 100 * DAY_MS });
      expect(isStale(c)).toBe(false);
    });

    it('is not stale while snoozed into the future', () => {
      const now = Date.now();
      const c = makeCommitment({ createdAt: now - 100 * DAY_MS, snoozedUntil: now + DAY_MS });
      expect(isStale(c, now)).toBe(false);
    });

    it('falls back to createdAt + staleAfterDays when remindAt is absent', () => {
      const now = Date.now();
      const fresh = makeCommitment({ createdAt: now - DAY_MS, staleAfterDays: 14 });
      const overdue = makeCommitment({ createdAt: now - 20 * DAY_MS, staleAfterDays: 14 });

      expect(isStale(fresh, now)).toBe(false);
      expect(isStale(overdue, now)).toBe(true);
    });

    it('uses remindAt when set, ignoring staleAfterDays', () => {
      const now = Date.now();
      const c = makeCommitment({ createdAt: now - 100 * DAY_MS, staleAfterDays: 365, remindAt: now - 1 });
      expect(isStale(c, now)).toBe(true);
    });
  });

  describe('addCommitment', () => {
    it('creates an open commitment and appends a commitment.created event', async () => {
      const commitment = await addCommitment({ text: 'Send X', personId: 'per_1', staleAfterDays: 14 });

      expect(commitment.status).toBe('open');
      expect(commitment.text).toBe('Send X');

      const events = await listEvents({ subjectType: 'commitment', subjectId: commitment.id });
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('commitment.created');
    });
  });

  describe('listCommitments', () => {
    it('filters by status and projectId', async () => {
      await addCommitment({ text: 'A', projectId: 'prj_1', staleAfterDays: 14 });
      const b = await addCommitment({ text: 'B', projectId: 'prj_2', staleAfterDays: 14 });
      await commitmentDone({ id: b.id });

      const openInProject1 = await listCommitments({ status: 'open', projectId: 'prj_1', staleOnly: false });
      expect(openInProject1.map((c) => c.text)).toEqual(['A']);
    });

    it('staleOnly filters down to overdue open commitments', async () => {
      const overdue = await addCommitment({ text: 'Overdue', remindAt: Date.now() - DAY_MS, staleAfterDays: 14 });
      await addCommitment({ text: 'Fresh', staleAfterDays: 365 });

      const staleOnes = await listCommitments({ staleOnly: true });
      expect(staleOnes.map((c) => c.id)).toContain(overdue.id);
      expect(staleOnes.map((c) => c.text)).not.toContain('Fresh');
    });

    it('sorts newest first', async () => {
      const first = await addCommitment({ text: 'First', staleAfterDays: 14 });
      await new Promise((r) => { setTimeout(r, 2); });
      const second = await addCommitment({ text: 'Second', staleAfterDays: 14 });

      const all = await listCommitments({ staleOnly: false });
      expect(all[0]!.id).toBe(second.id);
      expect(all[1]!.id).toBe(first.id);
    });
  });

  describe('commitmentDone', () => {
    it('returns null for an unknown id', async () => {
      expect(await commitmentDone({ id: 'nope' })).toBeNull();
    });

    it('marks a commitment done and appends a commitment.done event', async () => {
      const commitment = await addCommitment({ text: 'Finish', staleAfterDays: 14 });
      const done = await commitmentDone({ id: commitment.id });

      expect(done?.status).toBe('done');

      const events = await listEvents({ subjectType: 'commitment', subjectId: commitment.id, kind: 'commitment.done' });
      expect(events).toHaveLength(1);
    });
  });

  describe('commitmentDrop', () => {
    it('returns null for an unknown id', async () => {
      expect(await commitmentDrop({ id: 'nope', reason: 'x' })).toBeNull();
    });

    it('drops a commitment and records the reason in the event log', async () => {
      const commitment = await addCommitment({ text: 'Cancel me', staleAfterDays: 14 });
      const dropped = await commitmentDrop({ id: commitment.id, reason: 'No longer relevant' });

      expect(dropped?.status).toBe('dropped');

      const events = await listEvents({ subjectType: 'commitment', subjectId: commitment.id, kind: 'commitment.dropped' });
      expect(events[0]!.reason).toBe('No longer relevant');
    });
  });

  describe('commitmentSnooze', () => {
    it('returns null for an unknown id', async () => {
      expect(await commitmentSnooze({ id: 'nope', until: Date.now() })).toBeNull();
    });

    it('sets snoozedUntil and records the before/after transition', async () => {
      const commitment = await addCommitment({ text: 'Wait for it', staleAfterDays: 14 });
      const until = Date.now() + 30 * DAY_MS;
      const snoozed = await commitmentSnooze({ id: commitment.id, until, reason: 'Waiting on client' });

      expect(snoozed?.snoozedUntil).toBe(until);

      const events = await listEvents({
        subjectType: 'commitment',
        subjectId: commitment.id,
        kind: 'commitment.rescheduled',
      });
      expect(events[0]!.meta).toMatchObject({ to: until });
      expect(events[0]!.reason).toBe('Waiting on client');
    });
  });
});
