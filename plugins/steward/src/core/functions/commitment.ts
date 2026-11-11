import {
  COLLECTIONS,
  type Commitment,
  type AddCommitmentInput,
  type ListCommitmentsInput,
  type CommitmentDoneInput,
  type CommitmentDropInput,
  type CommitmentSnoozeInput,
} from '../../contracts/index.js';
import { getDb } from '../db.js';
import { appendEvent } from './event.js';

export function isStale(c: Commitment, now = Date.now()): boolean {
  if (c.status !== 'open') {return false;}
  if (c.snoozedUntil && c.snoozedUntil > now) {return false;}
  const dueAt = c.remindAt ?? c.createdAt + c.staleAfterDays * 24 * 60 * 60 * 1000;
  return dueAt < now;
}

export async function addCommitment(input: AddCommitmentInput): Promise<Commitment> {
  const docs = await getDb();
  const commitment = await docs.insertOne<Commitment>(COLLECTIONS.commitments, {
    text: input.text,
    personId: input.personId,
    projectId: input.projectId,
    status: 'open',
    remindAt: input.remindAt,
    staleAfterDays: input.staleAfterDays,
  });
  await appendEvent({
    subjectType: 'commitment',
    subjectId: commitment.id,
    kind: 'commitment.created',
    text: commitment.text,
  });
  return commitment;
}

export async function listCommitments(input: ListCommitmentsInput): Promise<Commitment[]> {
  const docs = await getDb();
  const all = await docs.find<Commitment>(
    COLLECTIONS.commitments,
    {
      ...(input.status ? { status: input.status } : {}),
      ...(input.projectId ? { projectId: { $eq: input.projectId } } : {}),
    },
    { sort: { createdAt: -1 } },
  );
  return input.staleOnly ? all.filter((c) => isStale(c)) : all;
}

export async function commitmentDone(input: CommitmentDoneInput): Promise<Commitment | null> {
  const docs = await getDb();
  const updated = await docs.updateById<Commitment>(COLLECTIONS.commitments, input.id, {
    $set: { status: 'done' },
  });
  if (updated) {
    await appendEvent({ subjectType: 'commitment', subjectId: input.id, kind: 'commitment.done' });
  }
  return updated;
}

export async function commitmentDrop(input: CommitmentDropInput): Promise<Commitment | null> {
  const docs = await getDb();
  const updated = await docs.updateById<Commitment>(COLLECTIONS.commitments, input.id, {
    $set: { status: 'dropped' },
  });
  if (updated) {
    await appendEvent({
      subjectType: 'commitment',
      subjectId: input.id,
      kind: 'commitment.dropped',
      reason: input.reason,
    });
  }
  return updated;
}

export async function commitmentSnooze(input: CommitmentSnoozeInput): Promise<Commitment | null> {
  const docs = await getDb();
  const before = await docs.findById<Commitment>(COLLECTIONS.commitments, input.id);
  if (!before) {return null;}

  const updated = await docs.updateById<Commitment>(COLLECTIONS.commitments, input.id, {
    $set: { snoozedUntil: input.until },
  });
  if (updated) {
    await appendEvent({
      subjectType: 'commitment',
      subjectId: input.id,
      kind: 'commitment.rescheduled',
      reason: input.reason,
      meta: { from: before.snoozedUntil, to: input.until },
    });
  }
  return updated;
}
