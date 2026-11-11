import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestPlatform } from '@kb-labs/sdk/testing';
import { appendEvent, addEvent, listEvents } from '../../src/core/functions/event.js';

describe('event functions', () => {
  beforeEach(() => {
    setupTestPlatform();
  });

  afterEach(() => {
    setupTestPlatform();
  });

  describe('appendEvent', () => {
    it('inserts a timestamped event carrying the given kind/subject', async () => {
      const event = await appendEvent({
        subjectType: 'project',
        subjectId: 'prj_1',
        kind: 'note',
        text: 'hello',
      });

      expect(event.id).toBeDefined();
      expect(event.at).toBeTypeOf('number');
      expect(event.subjectType).toBe('project');
      expect(event.subjectId).toBe('prj_1');
      expect(event.text).toBe('hello');
    });
  });

  describe('addEvent', () => {
    it('is the manual-note entry point used by the CLI/backfill', async () => {
      const event = await addEvent({
        subjectType: 'person',
        subjectId: 'per_1',
        kind: 'note',
        text: 'Talked at the conference',
      });

      expect(event.kind).toBe('note');
      expect(event.text).toBe('Talked at the conference');
    });
  });

  describe('listEvents', () => {
    it('filters by subjectType, subjectId, and kind independently', async () => {
      await addEvent({ subjectType: 'project', subjectId: 'prj_1', kind: 'note', text: 'a' });
      await addEvent({ subjectType: 'project', subjectId: 'prj_2', kind: 'note', text: 'b' });
      await addEvent({ subjectType: 'person', subjectId: 'prj_1', kind: 'note', text: 'c' });

      expect(await listEvents({ subjectType: 'project' })).toHaveLength(2);
      expect(await listEvents({ subjectId: 'prj_1' })).toHaveLength(2);
      expect(await listEvents({ subjectType: 'project', subjectId: 'prj_1' })).toHaveLength(1);
    });

    it('filters by since (epoch ms lower bound)', async () => {
      await addEvent({ subjectType: 'project', subjectId: 'prj_1', kind: 'note', text: 'old' });
      const cutoff = Date.now() + 1;
      await new Promise((r) => { setTimeout(r, 2); });
      await addEvent({ subjectType: 'project', subjectId: 'prj_1', kind: 'note', text: 'new' });

      const recent = await listEvents({ since: cutoff });
      expect(recent.map((e) => e.text)).toEqual(['new']);
    });

    it('sorts newest first', async () => {
      const first = await addEvent({ subjectType: 'project', subjectId: 'prj_1', kind: 'note', text: 'first' });
      await new Promise((r) => { setTimeout(r, 2); });
      const second = await addEvent({ subjectType: 'project', subjectId: 'prj_1', kind: 'note', text: 'second' });

      const events = await listEvents({ subjectId: 'prj_1' });
      expect(events[0]!.id).toBe(second.id);
      expect(events[1]!.id).toBe(first.id);
    });

    it('returns an empty list when nothing matches', async () => {
      expect(await listEvents({ subjectId: 'unknown' })).toEqual([]);
    });
  });
});
