export function createGitRemoteOperations(execute, RemoteOperationError, RemoteNotFoundError = RemoteOperationError) {
  const withGhCredentials = (args) => ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args];
  return {
    remoteUrl: async (remoteName) => execute('git', ['remote', 'get-url', remoteName]),
    pushRef: async (remoteName, ref, sha) => execute('git', withGhCredentials(['push', remoteName, `${sha}:refs/heads/${ref}`]), { retryable: true }),
    resolveRef: async (remoteName, ref) => {
      const output = execute('git', withGhCredentials(['ls-remote', remoteName, `refs/heads/${ref}`]), { retryable: true });
      const [resolvedSha] = output.split(/\s+/);
      if (!resolvedSha) throw new RemoteNotFoundError(`Verification ref ${ref} does not exist on remote ${remoteName}`);
      return resolvedSha;
    },
    deleteRef: async (remoteName, ref) => execute('git', withGhCredentials(['push', remoteName, `:refs/heads/${ref}`]), { retryable: true }),
  };
}
