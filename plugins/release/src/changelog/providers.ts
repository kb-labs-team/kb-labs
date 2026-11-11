/**
 * Git provider detection and link formatting
 * Supports GitHub, GitLab, and self-hosted instances
 */

import simpleGit from 'simple-git';
import { parseGitUrl } from './git-range';
import type { Change, GitProvider } from './types';

/**
 * Auto-detect git provider from remote
 */
export async function detectProvider(cwd: string, baseUrl?: string | null): Promise<GitProvider> {
  if (baseUrl) {
    // Explicit base URL provided
    return {
      type: inferProviderType(baseUrl),
      baseUrl,
    };
  }
  
  const git = simpleGit(cwd);
  
  try {
    const remotes = await git.getRemotes(true);
    const url = remotes[0]?.refs?.fetch || remotes[0]?.refs?.push;
    
    if (!url) {
      return { type: 'generic', baseUrl: null };
    }
    
    const parsed = parseGitUrl(url);
    if (!parsed) {
      return { type: 'generic', baseUrl: null };
    }
    
    const providerUrl = `https://${parsed.host}/${parsed.owner}/${parsed.repo}`;
    
    return {
      type: inferProviderType(providerUrl),
      baseUrl: providerUrl,
    };
  } catch (error) {
    return { type: 'generic', baseUrl: null };
  }
}

/**
 * Infer provider type from URL
 */
function inferProviderType(url: string): 'github' | 'gitlab' | 'generic' {
  if (url.includes('github.com') || url.includes('githubusercontent.com')) {
    return 'github';
  }
  if (url.includes('gitlab.com') || url.includes('gitlab')) {
    return 'gitlab';
  }
  return 'generic';
}

/**
 * Format commit link
 */
export function formatCommitLink(provider: GitProvider, sha: string): string | undefined {
  if (!provider.baseUrl) {return undefined;}
  
  if (provider.type === 'github') {
    return `${provider.baseUrl}/commit/${sha}`;
  }
  if (provider.type === 'gitlab') {
    return `${provider.baseUrl}/-/commit/${sha}`;
  }
  
  return undefined;
}

/**
 * Format PR link
 */
export function formatPrLink(provider: GitProvider, prNumber: string): string | undefined {
  if (!provider.baseUrl) {return undefined;}
  
  if (provider.type === 'github') {
    return `${provider.baseUrl}/pull/${prNumber}`;
  }
  if (provider.type === 'gitlab') {
    return `${provider.baseUrl}/-/merge_requests/${prNumber}`;
  }
  
  return undefined;
}

/**
 * Format issue link
 */
export function formatIssueLink(provider: GitProvider, issueNumber: string): string | undefined {
  if (!provider.baseUrl) {return undefined;}
  
  if (provider.type === 'github') {
    return `${provider.baseUrl}/issues/${issueNumber}`;
  }
  if (provider.type === 'gitlab') {
    return `${provider.baseUrl}/-/issues/${issueNumber}`;
  }
  
  return undefined;
}

/**
 * Enhance change with provider links
 */
export function enhanceChangeWithLinks(change: Change, provider: GitProvider): Change {
  const providerLinks: Change['providerLinks'] = {
    commit: formatCommitLink(provider, change.sha),
    pr: [],
    issues: [],
  };
  
  for (const ref of change.refs) {
    if (ref.type === 'pr') {
      const link = formatPrLink(provider, ref.id);
      if (link) {
        providerLinks.pr!.push(link);
        ref.url = link;
      }
    } else if (ref.type === 'issue') {
      const link = formatIssueLink(provider, ref.id);
      if (link) {
        providerLinks.issues!.push(link);
        ref.url = link;
      }
    }
  }
  
  if (!providerLinks.pr!.length) {delete providerLinks.pr;}
  if (!providerLinks.issues!.length) {delete providerLinks.issues;}
  
  return {
    ...change,
    providerLinks,
  };
}


