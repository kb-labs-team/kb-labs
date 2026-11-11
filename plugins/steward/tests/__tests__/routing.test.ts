import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestPlatform } from '@kb-labs/sdk/testing';
import { whoToContact } from '../../src/core/functions/routing.js';
import { addPerson, addMember } from '../../src/core/functions/person.js';
import { addTopic } from '../../src/core/functions/topic.js';

describe('whoToContact', () => {
  beforeEach(() => {
    setupTestPlatform();
  });

  afterEach(() => {
    setupTestPlatform();
  });

  it('matches project-scoped members by topic, sorted by priority ascending', async () => {
    const { person: alice } = await addPerson({ name: 'Alice', contacts: [], globalTopics: [] });
    const { person: bob } = await addPerson({ name: 'Bob', contacts: [], globalTopics: [] });

    await addMember({ personId: bob.id, projectId: 'prj_1', role: 'dev', topics: ['frontend'], priority: 5 });
    await addMember({ personId: alice.id, projectId: 'prj_1', role: 'lead', topics: ['frontend'], priority: 0 });

    const candidates = await whoToContact({ topic: 'frontend', projectId: 'prj_1' });

    expect(candidates.map((c) => c.person.id)).toEqual([alice.id, bob.id]);
    expect(candidates.every((c) => c.source === 'project')).toBe(true);
    expect(candidates[0]!.priority).toBe(0);
    expect(candidates[1]!.priority).toBe(5);
  });

  it('falls back to global competencies for people not matched at the project level', async () => {
    const { person: carol } = await addPerson({ name: 'Carol', contacts: [], globalTopics: ['grafana'] });

    const candidates = await whoToContact({ topic: 'grafana' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.person.id).toBe(carol.id);
    expect(candidates[0]!.source).toBe('global');
    expect(candidates[0]!.priority).toBeUndefined();
  });

  it('does not list a project-matched person again as a global match', async () => {
    const { person: alice } = await addPerson({ name: 'Alice', contacts: [], globalTopics: ['frontend'] });
    await addMember({ personId: alice.id, projectId: 'prj_1', role: 'lead', topics: ['frontend'], priority: 0 });

    const candidates = await whoToContact({ topic: 'frontend', projectId: 'prj_1' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.source).toBe('project');
  });

  it('matches topics case-insensitively, both at project and global level', async () => {
    const { person: alice } = await addPerson({ name: 'Alice', contacts: [], globalTopics: [] });
    await addMember({ personId: alice.id, projectId: 'prj_1', role: 'lead', topics: ['Frontend'], priority: 0 });
    const { person: bob } = await addPerson({ name: 'Bob', contacts: [], globalTopics: ['GRAFANA'] });

    const projectMatches = await whoToContact({ topic: 'frontend', projectId: 'prj_1' });
    expect(projectMatches.map((c) => c.person.id)).toEqual([alice.id]);

    const globalMatches = await whoToContact({ topic: 'grafana' });
    expect(globalMatches.map((c) => c.person.id)).toEqual([bob.id]);
  });

  it('resolves the topic through the dictionary — an alias query finds contacts registered under the canonical name', async () => {
    await addTopic({ name: 'frontend', aliases: ['фронт', 'front-end'] });
    const { person: alice } = await addPerson({ name: 'Alice', contacts: [], globalTopics: ['frontend'] });

    const candidates = await whoToContact({ topic: 'front-end' });

    expect(candidates.map((c) => c.person.id)).toEqual([alice.id]);
  });

  it('returns an empty list when nobody matches', async () => {
    await addPerson({ name: 'Alice', contacts: [], globalTopics: ['backend'] });
    const candidates = await whoToContact({ topic: 'frontend' });
    expect(candidates).toEqual([]);
  });
});
