/**
 * Zod schemas for everything that crosses the CLI/MCP boundary — command
 * inputs and the results agents read back. Domain models in `types/` stay
 * plain interfaces (see ADR-0001 §"Разделение core/entry").
 */
import { z } from 'zod';
import { DEFAULT_STALE_AFTER_DAYS } from './constants.js';

// ── Project ──────────────────────────────────────────────────────────────

export const AddProjectInputSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['active', 'paused', 'archived']).default('active'),
  description: z.string().optional(),
});
export type AddProjectInput = z.infer<typeof AddProjectInputSchema>;

export const UpdateProjectInputSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  description: z.string().optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

export const ListProjectsInputSchema = z.object({
  status: z.enum(['active', 'paused', 'archived']).optional(),
});
export type ListProjectsInput = z.infer<typeof ListProjectsInputSchema>;

// ── Resource ─────────────────────────────────────────────────────────────

export const AddResourceInputSchema = z
  .object({
    projectId: z.string().min(1),
    type: z.string().min(1),
    label: z.string().min(1),
    url: z.string().url().optional(),
    content: z.string().optional(),
  })
  .refine((v) => v.url !== undefined || v.content !== undefined, {
    message: 'at least one of url/content must be set',
  });
export type AddResourceInput = z.infer<typeof AddResourceInputSchema>;

// ── Person / Company / ProjectMember ────────────────────────────────────

export const ContactInputSchema = z.object({
  channel: z.enum(['telegram', 'email', 'phone', 'other']),
  value: z.string().min(1),
  priority: z.number().int().min(0).default(0),
});

export const AddPersonInputSchema = z.object({
  name: z.string().min(1),
  contacts: z.array(ContactInputSchema).default([]),
  companyId: z.string().optional(),
  globalTopics: z.array(z.string()).default([]),
});
export type AddPersonInput = z.infer<typeof AddPersonInputSchema>;

export const UpdatePersonInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  contacts: z.array(ContactInputSchema).optional(),
  companyId: z.string().optional(),
  globalTopics: z.array(z.string()).optional(),
});
export type UpdatePersonInput = z.infer<typeof UpdatePersonInputSchema>;

export const AddCompanyInputSchema = z.object({
  name: z.string().min(1),
});
export type AddCompanyInput = z.infer<typeof AddCompanyInputSchema>;

export const AddMemberInputSchema = z.object({
  personId: z.string().min(1),
  projectId: z.string().min(1),
  role: z.string().min(1),
  topics: z.array(z.string()).optional(),
  priority: z.number().int().min(0).default(0),
});
export type AddMemberInput = z.infer<typeof AddMemberInputSchema>;

// ── Routing ──────────────────────────────────────────────────────────────

export const WhoToContactInputSchema = z.object({
  topic: z.string().min(1),
  projectId: z.string().optional(),
});
export type WhoToContactInput = z.infer<typeof WhoToContactInputSchema>;

// ── Commitment ───────────────────────────────────────────────────────────

export const AddCommitmentInputSchema = z.object({
  text: z.string().min(1),
  personId: z.string().optional(),
  projectId: z.string().optional(),
  remindAt: z.number().optional(),
  staleAfterDays: z.number().int().positive().default(DEFAULT_STALE_AFTER_DAYS),
});
export type AddCommitmentInput = z.infer<typeof AddCommitmentInputSchema>;

export const ListCommitmentsInputSchema = z.object({
  status: z.enum(['open', 'done', 'dropped']).optional(),
  projectId: z.string().optional(),
  staleOnly: z.boolean().default(false),
});
export type ListCommitmentsInput = z.infer<typeof ListCommitmentsInputSchema>;

export const CommitmentDoneInputSchema = z.object({ id: z.string().min(1) });
export type CommitmentDoneInput = z.infer<typeof CommitmentDoneInputSchema>;

export const CommitmentDropInputSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
});
export type CommitmentDropInput = z.infer<typeof CommitmentDropInputSchema>;

export const CommitmentSnoozeInputSchema = z.object({
  id: z.string().min(1),
  until: z.number(),
  reason: z.string().optional(),
});
export type CommitmentSnoozeInput = z.infer<typeof CommitmentSnoozeInputSchema>;

// ── Event ────────────────────────────────────────────────────────────────

export const AddEventInputSchema = z.object({
  subjectType: z.enum(['project', 'person', 'commitment', 'company', 'resource']),
  subjectId: z.string().min(1),
  kind: z.string().min(1).default('note'),
  text: z.string().optional(),
  reason: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type AddEventInput = z.infer<typeof AddEventInputSchema>;

export const ListEventsInputSchema = z.object({
  subjectType: z.enum(['project', 'person', 'commitment', 'company', 'resource']).optional(),
  subjectId: z.string().optional(),
  kind: z.string().optional(),
  since: z.number().optional(),
});
export type ListEventsInput = z.infer<typeof ListEventsInputSchema>;

// ── Topic ────────────────────────────────────────────────────────────────

export const AddTopicInputSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
});
export type AddTopicInput = z.infer<typeof AddTopicInputSchema>;
