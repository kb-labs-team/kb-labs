import { z } from 'zod'

// ─── fetch-issue ──────────────────────────────────────────────────────────────

export const FetchIssueInputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  issueNumber: z.number(),
  token: z.string().optional(),
})
export type FetchIssueInput = z.infer<typeof FetchIssueInputSchema>

export const FetchIssueOutputSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  url: z.string(),
  labels: z.array(z.string()),
  author: z.string(),
})
export type FetchIssueOutput = z.infer<typeof FetchIssueOutputSchema>

// ─── post-comment ─────────────────────────────────────────────────────────────

export const PostCommentInputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  issueNumber: z.number(),
  body: z.string(),
  token: z.string().optional(),
})
export type PostCommentInput = z.infer<typeof PostCommentInputSchema>

export const PostCommentOutputSchema = z.object({
  commentId: z.number(),
  url: z.string(),
})
export type PostCommentOutput = z.infer<typeof PostCommentOutputSchema>

// ─── create-branch ────────────────────────────────────────────────────────────

export const CreateBranchInputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  branchName: z.string(),
  fromBranch: z.string().default('main'),
  token: z.string().optional(),
})
export type CreateBranchInput = z.infer<typeof CreateBranchInputSchema>

export const CreateBranchOutputSchema = z.object({
  branchName: z.string(),
  sha: z.string(),
  url: z.string(),
})
export type CreateBranchOutput = z.infer<typeof CreateBranchOutputSchema>

// ─── create-pr ────────────────────────────────────────────────────────────────

export const CreatePRInputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  title: z.string(),
  body: z.string().optional().default(''),
  head: z.string(),
  base: z.string().default('main'),
  issueNumber: z.number().optional(),
  labels: z.array(z.string()).optional().default([]),
  token: z.string().optional(),
})
export type CreatePRInput = z.infer<typeof CreatePRInputSchema>

export const CreatePROutputSchema = z.object({
  prNumber: z.number(),
  url: z.string(),
  title: z.string(),
})
export type CreatePROutput = z.infer<typeof CreatePROutputSchema>
