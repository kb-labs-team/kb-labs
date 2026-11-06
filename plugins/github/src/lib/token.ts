import { execSync } from 'node:child_process'
import { useEnv } from '@kb-labs/sdk'

let ghCliFallbackToken: string | null | undefined

/**
 * Resolves the GitHub token to use for API calls.
 *
 * Precedence: explicit `token` argument > `GITHUB_WORKFLOW_TOKEN` env var >
 * `gh auth token` (the CLI's own cached auth). The env var is not guaranteed
 * to survive a daemon restart if the process that launched it never
 * exported one — falling back to `gh`'s own token avoids every GitHub step
 * failing with a silent 401 in that case. Cached per-process since `gh auth
 * token` shells out and the result doesn't change within a run.
 */
export function resolveGithubToken(token?: string): string | undefined {
  if (token) return token

  const envToken = useEnv('GITHUB_WORKFLOW_TOKEN')
  if (envToken) return envToken

  if (ghCliFallbackToken === undefined) {
    try {
      ghCliFallbackToken = execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || null
    } catch {
      ghCliFallbackToken = null
    }
  }

  return ghCliFallbackToken ?? undefined
}
