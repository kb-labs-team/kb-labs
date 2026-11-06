import path from 'node:path';

export function usage() {
  return 'Usage: node scripts/ci/remote-verify.mjs <stream> [--profile candidate] --out <path> | --attach <verify-ref-or-run-id> --out <path>';
}

export function parseArgs(args, cwd = process.cwd()) {
  let stream;
  let attach;
  let out;
  let profile = 'stream';
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--attach' || item === '--out' || item === '--profile') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${usage()}\nMissing value for ${item}`);
      if (item === '--attach') attach = value;
      else if (item === '--out') out = value;
      else profile = value;
    } else if (!item.startsWith('--') && !stream) {
      stream = item;
    } else {
      throw new Error(`${usage()}\nUnexpected argument: ${item}`);
    }
  }
  if (!out) throw new Error(`${usage()}\nThe --out path is required; pass a destination outside the worktree, such as ../reports/<stream>.remote-verify.json.`);
  if (Boolean(attach) === Boolean(stream)) throw new Error(`${usage()}\nProvide exactly one stream name or --attach value.`);
  if (stream && !/^[a-zA-Z0-9._-]+$/.test(stream)) throw new Error(`${usage()}\nStream name may contain only letters, numbers, dot, underscore, and hyphen.`);
  if (!['stream', 'candidate'].includes(profile)) throw new Error(`${usage()}\nProfile must be stream or candidate.`);
  if (attach && profile !== 'stream') throw new Error(`${usage()}\n--profile applies only to a new verification run.`);
  return { stream, attach, profile, out: path.resolve(cwd, out) };
}
