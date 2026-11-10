export function createGitRemoteOperations(execute, RemoteOperationError) {
  return {
    remoteUrl: async (remoteName) => execute('git', ['remote', 'get-url', remoteName]),
    pushRef: async (remoteName, ref, sha) => execute('git', ['push', remoteName, `${sha}:refs/heads/${ref}`], { retryable: true }),
    resolveRef: async (remoteName, ref) => {
      const output = execute('git', ['ls-remote', remoteName, `refs/heads/${ref}`], { retryable: true });
      const [resolvedSha] = output.split(/\s+/);
      if (!resolvedSha) throw new RemoteOperationError(`Verification ref ${ref} does not exist on remote ${remoteName}`, { retryable: true });
      return resolvedSha;
    },
    deleteRef: async (remoteName, ref) => execute('git', ['push', remoteName, `:refs/heads/${ref}`], { retryable: true }),
  };
}
