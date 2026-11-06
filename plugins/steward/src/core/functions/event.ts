import { COLLECTIONS, type Event, type EventSubjectType } from '../../contracts/index.js';
import type { AddEventInput, ListEventsInput } from '../../contracts/index.js';
import { getDb } from '../db.js';

/**
 * Append-only write used both by the manual `event add` command and by every
 * other function that records a lifecycle transition (commitment done/drop,
 * project status change, ...). Never updates or deletes.
 */
export async function appendEvent(input: {
  subjectType: EventSubjectType;
  subjectId: string;
  kind: string;
  text?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}): Promise<Event> {
  const docs = await getDb();
  return docs.insertOne<Event>(COLLECTIONS.events, {
    at: Date.now(),
    kind: input.kind as Event['kind'],
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    text: input.text,
    reason: input.reason,
    meta: input.meta,
  });
}

export async function addEvent(input: AddEventInput): Promise<Event> {
  return appendEvent({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    kind: input.kind,
    text: input.text,
    reason: input.reason,
    meta: input.meta,
  });
}

export async function listEvents(input: ListEventsInput): Promise<Event[]> {
  const docs = await getDb();
  return docs.find<Event>(
    COLLECTIONS.events,
    {
      ...(input.subjectType ? { subjectType: input.subjectType } : {}),
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
      ...(input.kind ? { kind: input.kind as Event['kind'] } : {}),
      ...(input.since ? { at: { $gte: input.since } } : {}),
    },
    { sort: { at: -1 } },
  );
}
