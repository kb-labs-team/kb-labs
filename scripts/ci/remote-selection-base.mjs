export function candidateBaseRef({ profile, baseRef, emptyTreeRef }) {
  if (profile === 'stream' || profile === 'platform') {
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

export function isPlatformVerificationRef(ref) {
  return /^verify\/platform\/[A-Za-z0-9._-]+\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}$/.test(ref ?? '');
}

export function candidateSelectionBase({ profile, branch, requestedBaseRef, emptyTreeRef }) {
  if (profile === 'candidate') {
    return { baseRef: emptyTreeRef, fullReason: 'full: candidate verification selects the complete workspace' };
  }
  if (profile !== 'stream' && profile !== 'platform') throw new Error(`Unsupported verification profile: ${profile}`);
  if (profile === 'platform' && !isPlatformVerificationRef(branch)) throw new Error(`Platform verification requires a verify/platform/<stream>/<timestamp>-<sha> ref; received ${branch || '(unknown)'}.`);
  const expectedBase = profile === 'platform'
    ? 'origin/master'
    : (branch.startsWith('verify/') ? 'origin/master' : '');
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

export function accountedEmptyPlatformSelection({ profile, packages, scope }) {
  return profile === 'platform' && Array.isArray(packages) && packages.length === 0
    && Array.isArray(scope?.excludedPackages) && scope.excludedPackages.length > 0;
}
