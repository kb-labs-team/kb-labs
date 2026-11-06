import { defineHandler, rethrowForRest } from '@kb-labs/sdk'
import type { FetchIssueInput, FetchIssueOutput } from '../contracts/index.js'
import { resolveGithubToken } from '../lib/token.js'

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const tok = resolveGithubToken(token)
  if (tok) h.Authorization = `Bearer ${tok}`
  return h
}

export default defineHandler<unknown, FetchIssueInput, FetchIssueOutput>({
  async execute(ctx, input) {
    try {
      const { owner, repo, issueNumber, token } = input

      const res = await ctx.runtime.fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
        { headers: headers(token) },
      )
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)

      const issue = await res.json() as Record<string, unknown>
      return {
        number: issue.number as number,
        title: issue.title as string,
        body: (issue.body ?? null) as string | null,
        state: issue.state as string,
        url: issue.html_url as string,
        labels: ((issue.labels as Array<{ name: string }>) ?? []).map((l) => l.name),
        author: (issue.user as { login: string })?.login ?? '',
      }
    } catch (err) {
      rethrowForRest(err)
    }
  },
})
