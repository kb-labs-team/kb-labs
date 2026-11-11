import {
  COLLECTIONS,
  type Person,
  type Company,
  type ProjectMember,
  type AddPersonInput,
  type UpdatePersonInput,
  type AddCompanyInput,
  type AddMemberInput,
} from '../../contracts/index.js';
import { getDb } from '../db.js';
import { resolveTopic } from './topic.js';

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Resolves every topic to its dictionary canonical form — normalization happens on write (ADR-0001 §Routing). */
async function resolveTopics(topics: string[]): Promise<string[]> {
  return Promise.all(topics.map((t) => resolveTopic(t)));
}

/**
 * Cheap dedup signal on the write path (ADR-0001 §8): a normalized-name
 * match, not a hard constraint. The caller decides whether to still insert.
 */
export async function findPossibleDuplicates(name: string): Promise<Person[]> {
  const docs = await getDb();
  const normalized = normalizeName(name);
  const all = await docs.find<Person>(COLLECTIONS.people, {});
  return all.filter((p) => normalizeName(p.name) === normalized);
}

export interface AddPersonResult {
  person: Person;
  possibleDuplicates: Person[];
}

export async function addPerson(input: AddPersonInput): Promise<AddPersonResult> {
  const docs = await getDb();
  const possibleDuplicates = await findPossibleDuplicates(input.name);
  const person = await docs.insertOne<Person>(COLLECTIONS.people, {
    name: input.name,
    contacts: input.contacts,
    companyId: input.companyId,
    globalTopics: await resolveTopics(input.globalTopics),
  });
  return { person, possibleDuplicates };
}

export async function updatePerson(input: UpdatePersonInput): Promise<Person | null> {
  const docs = await getDb();
  return docs.updateById<Person>(COLLECTIONS.people, input.id, {
    $set: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.contacts !== undefined ? { contacts: input.contacts } : {}),
      ...(input.companyId !== undefined ? { companyId: input.companyId } : {}),
      ...(input.globalTopics !== undefined ? { globalTopics: await resolveTopics(input.globalTopics) } : {}),
    },
  });
}

/** Resolves by id first, falling back to an exact name match. */
export async function getPerson(idOrName: string): Promise<Person | null> {
  const docs = await getDb();
  const byId = await docs.findById<Person>(COLLECTIONS.people, idOrName);
  if (byId) {return byId;}
  const [byName] = await docs.find<Person>(COLLECTIONS.people, { name: { $eq: idOrName } });
  return byName ?? null;
}

export async function listPeople(): Promise<Person[]> {
  const docs = await getDb();
  return docs.find<Person>(COLLECTIONS.people, {}, { sort: { name: 1 } });
}

// ── Company (thin — see ADR-0001 §"Миграционная политика") ────────────────

export async function addCompany(input: AddCompanyInput): Promise<Company> {
  const docs = await getDb();
  return docs.insertOne<Company>(COLLECTIONS.companies, { name: input.name });
}

export async function listCompanies(): Promise<Company[]> {
  const docs = await getDb();
  return docs.find<Company>(COLLECTIONS.companies, {}, { sort: { name: 1 } });
}

// ── ProjectMember ────────────────────────────────────────────────────────

export async function addMember(input: AddMemberInput): Promise<ProjectMember> {
  const docs = await getDb();
  return docs.insertOne<ProjectMember>(COLLECTIONS.projectMembers, {
    personId: input.personId,
    projectId: input.projectId,
    role: input.role,
    topics: input.topics ? await resolveTopics(input.topics) : undefined,
    priority: input.priority,
  });
}

export async function listMembers(projectId: string): Promise<ProjectMember[]> {
  const docs = await getDb();
  return docs.find<ProjectMember>(
    COLLECTIONS.projectMembers,
    { projectId: { $eq: projectId } },
    { sort: { priority: 1 } },
  );
}
