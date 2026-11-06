import { COLLECTIONS, type Topic, type AddTopicInput } from '../../contracts/index.js';
import { getDb } from '../db.js';

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export async function addTopic(input: AddTopicInput): Promise<Topic> {
  const docs = await getDb();
  return docs.insertOne<Topic>(COLLECTIONS.topics, {
    name: input.name,
    aliases: input.aliases,
  });
}

export async function listTopics(): Promise<Topic[]> {
  const docs = await getDb();
  return docs.find<Topic>(COLLECTIONS.topics, {}, { sort: { name: 1 } });
}

/**
 * Resolves a free-text topic to its canonical dictionary name via name or
 * alias match. Falls back to the raw input when nothing is registered —
 * the dictionary is opt-in, not a hard gate (ADR-0001 §Routing).
 *
 * Array-field filtering (`aliases`) isn't part of `DocumentFilter`'s
 * contract (semantics diverge across drivers), so this matches in memory —
 * acceptable at the scale of a personal topic dictionary.
 */
export async function resolveTopic(raw: string): Promise<string> {
  const needle = normalize(raw);
  const all = await listTopics();
  const hit = all.find(
    (t) => normalize(t.name) === needle || t.aliases.some((a) => normalize(a) === needle),
  );
  return hit?.name ?? raw;
}
