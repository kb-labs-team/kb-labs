import { defineHandler, rethrowForRest } from '@kb-labs/sdk'
import type { CreatePRInput, CreatePROutput } from '../contracts/index.js'
import { resolveGithubToken } from '../lib/token.js'

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const tok = resolveGithubToken(token)
  if (tok) h.Authorization = `Bearer ${tok}`
  return h
}

export default defineHandler<unknown, CreatePRInput, CreatePROutput>({
  async execute(ctx, input) {
    try {
      const { owner, repo, title, body = '', head, base = 'main', issueNumber, labels = [], token } = input
      const hdrs = headers(token)

      const prBody = issueNumber ? `${body}\n\nCloses #${issueNumber}` : body

      const prRes = await ctx.runtime.fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
          method: 'POST',
          headers: hdrs,
          body: JSON.stringify({ title, body: prBody, head, base }),
        },
      )
      if (!prRes.ok) throw new Error(`GitHub ${prRes.status}: ${await prRes.text()}`)

      const pr = await prRes.json() as Record<string, unknown>
      const prNumber = pr.number as number

      // Apply labels (non-critical)
      if (labels.length > 0) {
        await ctx.runtime.fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/labels`,
          { method: 'POST', headers: hdrs, body: JSON.stringify({ labels }) },
        ).catch(() => undefined)
      }

      return {
        prNumber,
        url: pr.html_url as string,
        title: pr.title as string,
      }
    } catch (err) {
      rethrowForRest(err)
    }
  },
})
