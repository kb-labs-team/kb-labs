import { defineHandler, rethrowForRest } from '@kb-labs/sdk'
import type { CreateBranchInput, CreateBranchOutput } from '../contracts/index.js'
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

export default defineHandler<unknown, CreateBranchInput, CreateBranchOutput>({
  async execute(ctx, input) {
    try {
      const { owner, repo, branchName, fromBranch = 'main', token } = input
      const hdrs = headers(token)

      // Get SHA of the base branch
      const refRes = await ctx.runtime.fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`,
        { headers: hdrs },
      )
      if (!refRes.ok) throw new Error(`GitHub ${refRes.status}: ${await refRes.text()}`)

      const ref = await refRes.json() as Record<string, unknown>
      const sha = (ref.object as { sha: string }).sha

      // Create the new branch (idempotent — if already exists, use it)
      const createRes = await ctx.runtime.fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/refs`,
        {
          method: 'POST',
          headers: hdrs,
          body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
        },
      )

      if (!createRes.ok) {
        if (createRes.status === 422) {
          // Branch already exists — force-reset it to fromBranch SHA so the
          // new run starts clean without contamination from previous runs.
          const patchRes = await ctx.runtime.fetch(
            `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branchName}`,
            {
              method: 'PATCH',
              headers: hdrs,
              body: JSON.stringify({ sha, force: true }),
            },
          )
          if (!patchRes.ok) throw new Error(`GitHub ${patchRes.status}: ${await patchRes.text()}`)
          return {
            branchName,
            sha,
            url: `https://github.com/${owner}/${repo}/tree/${branchName}`,
          }
        }
        throw new Error(`GitHub ${createRes.status}: ${await createRes.text()}`)
      }

      return {
        branchName,
        sha,
        url: `https://github.com/${owner}/${repo}/tree/${branchName}`,
      }
    } catch (err) {
      rethrowForRest(err)
    }
  },
})
