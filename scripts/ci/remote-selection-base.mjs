export function candidateBaseRef({ profile, baseRef, emptyTreeRef }) {
  if (profile === 'stream') {
    if (!baseRef) throw new Error('Stream selection requires its configured default-branch base ref.');
    return baseRef;
  }
  if (profile !== 'candidate') throw new Error(`Unsupported verification profile: ${profile}`);
  return emptyTreeRef;
}

export function canonicalRemoteBaseRef(baseRef) {
  if (baseRef === 'origin/master') return 'refs/remotes/origin/master';
  return '';
}

export function candidateSelectionBase({ profile, branch, requestedBaseRef, emptyTreeRef }) {
  if (profile === 'candidate') {
    return { baseRef: emptyTreeRef, fullReason: 'full: candidate verification selects the complete workspace' };
  }
  if (profile !== 'stream') throw new Error(`Unsupported verification profile: ${profile}`);
  const expectedBase = branch.startsWith('verify/') ? 'origin/master' : '';
  if (!expectedBase) {
    return { baseRef: emptyTreeRef, fullReason: `full: ref ${branch || '(unknown)'} is not eligible for affected selection in the ${profile} profile` };
  }
  if (requestedBaseRef !== expectedBase) {
    return { baseRef: emptyTreeRef, fullReason: `full: affected selection requires base ${expectedBase}; selected the complete workspace` };
  }
  return { baseRef: expectedBase, fullReason: '' };
}

export function candidateFullFallbackReason({ baseSha, headSha, changedPathCount, packages }) {
  if (baseSha && headSha && baseSha === headSha) return 'full: selected base resolves to HEAD; selected the complete workspace';
  if (changedPathCount === 0) return 'full: candidate diff is empty; selected the complete workspace';
  if (Array.isArray(packages) && packages.length === 0) return 'full: empty affected selection for a non-empty diff; selected the complete workspace';
  return '';
}
