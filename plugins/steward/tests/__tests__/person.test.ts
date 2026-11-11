import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestPlatform } from '@kb-labs/sdk/testing';
import {
  addPerson,
  updatePerson,
  getPerson,
  listPeople,
  addCompany,
  listCompanies,
  addMember,
  listMembers,
  findPossibleDuplicates,
} from '../../src/core/functions/person.js';
import { addTopic } from '../../src/core/functions/topic.js';

describe('person functions', () => {
  beforeEach(() => {
    setupTestPlatform();
  });

  afterEach(() => {
    setupTestPlatform();
  });

  describe('findPossibleDuplicates', () => {
    it('matches on a normalized name (trim, case, internal whitespace)', async () => {
      await addPerson({ name: 'Ivan  Ivanov', contacts: [], globalTopics: [] });
      const dupes = await findPossibleDuplicates('  ivan ivanov ');
      expect(dupes).toHaveLength(1);
    });

    it('returns nothing for a genuinely new name', async () => {
      await addPerson({ name: 'Ivan Ivanov', contacts: [], globalTopics: [] });
      const dupes = await findPossibleDuplicates('Petr Petrov');
      expect(dupes).toEqual([]);
    });
  });

  describe('addPerson', () => {
    it('creates a contact and resolves global topics through the dictionary', async () => {
      await addTopic({ name: 'frontend', aliases: ['фронт', 'front-end'] });

      const { person, possibleDuplicates } = await addPerson({
        name: 'Ivanov',
        contacts: [],
        globalTopics: ['front-end', 'unregistered-topic'],
      });

      expect(person.name).toBe('Ivanov');
      expect(person.globalTopics).toEqual(['frontend', 'unregistered-topic']);
      expect(possibleDuplicates).toEqual([]);
    });

    it('does not error on a name collision — returns possibleDuplicates as a warning', async () => {
      await addPerson({ name: 'Ivanov', contacts: [], globalTopics: [] });
      const { person, possibleDuplicates } = await addPerson({ name: 'Ivanov', contacts: [], globalTopics: [] });

      expect(person.id).toBeDefined();
      expect(possibleDuplicates).toHaveLength(1);
      expect(possibleDuplicates[0]!.name).toBe('Ivanov');
    });
  });

  describe('updatePerson', () => {
    it('returns null for an unknown id', async () => {
      const result = await updatePerson({ id: 'nope' });
      expect(result).toBeNull();
    });

    it('updates only the provided fields and re-resolves topics', async () => {
      await addTopic({ name: 'backend', aliases: ['бэк'] });
      const { person } = await addPerson({ name: 'Original', contacts: [], globalTopics: [] });

      const updated = await updatePerson({ id: person.id, name: 'Renamed', globalTopics: ['бэк'] });

      expect(updated?.name).toBe('Renamed');
      expect(updated?.globalTopics).toEqual(['backend']);
    });
  });

  describe('getPerson', () => {
    it('resolves by id first, falling back to exact name match', async () => {
      const { person } = await addPerson({ name: 'Findable', contacts: [], globalTopics: [] });

      expect((await getPerson(person.id))?.id).toBe(person.id);
      expect((await getPerson('Findable'))?.id).toBe(person.id);
    });

    it('returns null when nothing matches', async () => {
      expect(await getPerson('missing')).toBeNull();
    });
  });

  describe('listPeople', () => {
    it('lists everyone sorted by name', async () => {
      await addPerson({ name: 'Zed', contacts: [], globalTopics: [] });
      await addPerson({ name: 'Anna', contacts: [], globalTopics: [] });

      const people = await listPeople();
      expect(people.map((p) => p.name)).toEqual(['Anna', 'Zed']);
    });
  });

  describe('company (thin)', () => {
    it('addCompany creates a name-only entity', async () => {
      const company = await addCompany({ name: 'Acme Corp' });
      expect(company.name).toBe('Acme Corp');
    });

    it('listCompanies sorts by name', async () => {
      await addCompany({ name: 'Zeta Inc' });
      await addCompany({ name: 'Acme Corp' });

      const companies = await listCompanies();
      expect(companies.map((c) => c.name)).toEqual(['Acme Corp', 'Zeta Inc']);
    });
  });

  describe('project member', () => {
    it('addMember resolves project-scoped topics and defaults priority', async () => {
      await addTopic({ name: 'architecture', aliases: ['архитектура'] });
      const member = await addMember({
        personId: 'per_1',
        projectId: 'prj_1',
        role: 'lead',
        topics: ['архитектура'],
        priority: 0,
      });

      expect(member.topics).toEqual(['architecture']);
      expect(member.priority).toBe(0);
    });

    it('listMembers returns members sorted by priority (the fallback chain)', async () => {
      await addMember({ personId: 'per_1', projectId: 'prj_1', role: 'lead', priority: 3 });
      await addMember({ personId: 'per_2', projectId: 'prj_1', role: 'backup', priority: 1 });
      await addMember({ personId: 'per_3', projectId: 'prj_2', role: 'other', priority: 0 });

      const members = await listMembers('prj_1');
      expect(members.map((m) => m.personId)).toEqual(['per_2', 'per_1']);
    });
  });
});
