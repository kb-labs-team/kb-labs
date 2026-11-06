import {
  COLLECTIONS,
  type Person,
  type ProjectMember,
  type WhoToContactInput,
} from '../../contracts/index.js';
import { getDb } from '../db.js';
import { resolveTopic } from './topic.js';

export interface ContactCandidate {
  person: Person;
  source: 'project' | 'global';
  /** Fallback order — lower is contacted first. Absent for global matches (unordered). */
  priority?: number;
}

/**
 * whoToContact(topic, projectId?) — hybrid lookup (ADR-0001 §Routing).
 *
 * With a `projectId`, `ProjectMember.topics` in that project take priority,
 * ordered by `ProjectMember.priority` (the fallback chain). Falls back to
 * `Person.globalTopics` across every contact.
 *
 * Topic array fields aren't filterable at the `DocumentFilter` level
 * (array-operator semantics diverge across drivers), so matching happens
 * in memory — fine at personal scale.
 */
export async function whoToContact(input: WhoToContactInput): Promise<ContactCandidate[]> {
  const docs = await getDb();
  const topic = await resolveTopic(input.topic);

  const candidates: ContactCandidate[] = [];

  if (input.projectId) {
    const members = await docs.find<ProjectMember>(COLLECTIONS.projectMembers, {
      projectId: { $eq: input.projectId },
    });
    const matching = members
      .filter((m) => (m.topics ?? []).some((t) => t.toLowerCase() === topic.toLowerCase()))
      .sort((a, b) => a.priority - b.priority);

    for (const member of matching) {
      const person = await docs.findById<Person>(COLLECTIONS.people, member.personId);
      if (person) {candidates.push({ person, source: 'project', priority: member.priority });}
    }
  }

  const allPeople = await docs.find<Person>(COLLECTIONS.people, {});
  const globalMatches = allPeople.filter(
    (p) =>
      !candidates.some((c) => c.person.id === p.id) &&
      p.globalTopics.some((t) => t.toLowerCase() === topic.toLowerCase()),
  );
  for (const person of globalMatches) {
    candidates.push({ person, source: 'global' });
  }

  return candidates;
}
