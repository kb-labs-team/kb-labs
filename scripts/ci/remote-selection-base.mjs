export function candidateBaseRef({ profile, baseRef, emptyTreeRef }) {
  if (profile === 'stream') {
    if (!baseRef) throw new Error('Stream selection requires its configured default-branch base ref.');
    return baseRef;
  }
  if (profile !== 'candidate') throw new Error(`Unsupported verification profile: ${profile}`);
  return baseRef || emptyTreeRef;
}

export function candidateIntegrationBase(branch) {
  return branch.startsWith('agent/') && branch !== 'agent/j90-integration' ? 'origin/agent/j90-integration' : '';
}
