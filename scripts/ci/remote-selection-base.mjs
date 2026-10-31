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

export function candidateSelectionBase({ branch, requestedBaseRef, emptyTreeRef }) {
  const integrationBase = candidateIntegrationBase(branch);
  if (!integrationBase) {
    return { baseRef: emptyTreeRef, fullReason: `full: ref ${branch || '(unknown)'} is not an eligible agent stream ref` };
  }
  if (requestedBaseRef !== integrationBase) {
    return { baseRef: emptyTreeRef, fullReason: `full: affected selection requires base ${integrationBase}; selected the complete workspace` };
  }
  return { baseRef: integrationBase, fullReason: '' };
}

export function candidateFullFallbackReason({ baseSha, headSha, changedPathCount, packages }) {
  if (baseSha && headSha && baseSha === headSha) return 'full: candidate base resolves to HEAD; selected the complete workspace';
  if (changedPathCount === 0) return 'full: candidate diff is empty; selected the complete workspace';
  if (Array.isArray(packages) && packages.length === 0) return 'full: empty affected selection for a non-empty diff; selected the complete workspace';
  return '';
}
