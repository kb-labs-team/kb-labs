declare module '@kb-labs/core-sys' {
  export function findRepoRoot(cwd?: string): Promise<string>;
}
