import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function trackedDockerfiles(repositoryRoot) {
  const result = spawnSync('git', ['ls-files', '-z', '--', '*Dockerfile*'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ls-files exited ${result.status}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

export function parseDockerfileFromInstructions(source) {
  const lines = source.split(/\r?\n/);
  const escape = dockerfileEscapeCharacter(lines);
  const instructions = [];
  const globalArgs = new Map();
  const declaredArgs = new Set();
  let sawFrom = false;
  for (let index = 0; index < lines.length;) {
    const firstLine = index + 1;
    let instruction = lines[index].trim();
    index += 1;
    while (endsWithUnescaped(instruction, escape) && index < lines.length) {
      instruction = `${instruction.slice(0, -1)} ${lines[index].trim()}`;
      index += 1;
    }
    if (instruction === '' || instruction.startsWith('#')) continue;

    const tokens = instruction.split(/\s+/);
    const keyword = tokens.shift().toUpperCase();
    if (keyword === 'ARG' && !sawFrom) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(tokens[0] ?? '');
      if (assignment) {
        declaredArgs.add(assignment[1]);
        if (assignment[2] !== undefined) globalArgs.set(assignment[1], assignment[2]);
      }
      continue;
    }
    if (keyword !== 'FROM') continue;
    sawFrom = true;

    if (tokens[0]?.startsWith('--')) tokens.shift();
    const image = tokens.shift();
    if (!image || (tokens.length > 0 && (tokens.length !== 2 || tokens[0].toUpperCase() !== 'AS'))) {
      instructions.push({ line: firstLine, error: 'malformed FROM instruction' });
      continue;
    }
    try {
      const resolution = resolveImageArguments(image, globalArgs, declaredArgs);
      const stage = tokens[0]?.toUpperCase() === 'AS' ? tokens[1] : undefined;
      if (resolution.externalArgs.length > 0) {
        instructions.push({ line: firstLine, externalImage: image, externalArgs: resolution.externalArgs, ...(stage ? { stage } : {}) });
      } else {
        instructions.push({ line: firstLine, image: resolution.image, ...(stage ? { stage } : {}) });
      }
    } catch (error) {
      instructions.push({ line: firstLine, error: error.message });
    }
  }
  return instructions;
}

export function nodeImageIssues(repositoryRoot, requiredMajor, { includeJourneyRunnerContract = false } = {}) {
  const issues = [];
  const toolchainContract = includeJourneyRunnerContract ? readToolchainContract() : undefined;
  const nodePolicy = includeJourneyRunnerContract
    ? JSON.parse(readFileSync(path.join(repositoryRoot, 'tools/clikit/toolchain/node_policy_gen.json'), 'utf8'))
    : undefined;
  for (const relativeFile of trackedDockerfiles(repositoryRoot)) {
    const absoluteFile = path.join(repositoryRoot, relativeFile);
    const source = readFileSync(absoluteFile, 'utf8');
    const fromInstructions = parseDockerfileFromInstructions(source);
    const toolchainStage = toolchainContract
      ? fromInstructions.find((from) => from.stage === toolchainContract.toolchainStage)
      : undefined;
    for (const from of fromInstructions) {
      if (from.error) {
        issues.push({ file: `${relativeFile}:${from.line}`, message: from.error });
        continue;
      }

      if (from.externalImage !== undefined) {
        const isPolicyNodeImage = toolchainContract !== undefined && nodePolicy !== undefined
          && relativeFile === toolchainContract.dockerfile
          && from.stage === toolchainContract.toolchainStage
          && from.externalArgs.length === 1
          && from.externalArgs[0] === nodePolicy.nodeBaseImageArgument
          && toolchainStage === from;
        const isDerivedRunnerImage = toolchainContract !== undefined && nodePolicy !== undefined
          && relativeFile === toolchainContract.dockerfile
          && from.externalArgs.length === 1
          && from.externalArgs[0] === toolchainContract.imageArgument
          && from.externalImage === `\${${toolchainContract.imageArgument}}`
          && toolchainStage !== undefined
          && (toolchainStage.image?.startsWith('node:')
            || (toolchainStage.externalArgs?.length === 1
              && toolchainStage.externalArgs[0] === nodePolicy.nodeBaseImageArgument));
        if (!isDerivedRunnerImage && !isPolicyNodeImage) {
          issues.push({
            file: `${relativeFile}:${from.line}`,
            message: `FROM image ${JSON.stringify(from.externalImage)} is not derived from the checked runner toolchain stage`,
          });
        }
        continue;
      }

      const image = from.image;
      if (image !== 'node' && !image.startsWith('node:') && !image.startsWith('node@')) continue;

      const tag = image.startsWith('node:') ? image.slice('node:'.length).split('@')[0] : '';
      const match = /^(0|[1-9]\d*)(?:[.-]|$)/.exec(tag);
      if (!match) {
        issues.push({
          file: `${relativeFile}:${from.line}`,
          message: `FROM image ${JSON.stringify(image)} must have a numeric Node major tag matching ${requiredMajor}.x`,
        });
        continue;
      }
      const imageMajor = Number(match[1]);
      if (imageMajor !== requiredMajor) {
        issues.push({
          file: `${relativeFile}:${from.line}`,
          message: `FROM image ${JSON.stringify(image)} uses Node ${imageMajor}; root package.json requires ${requiredMajor}.x`,
        });
      }
    }
  }
  return issues;
}

function readToolchainContract() {
  const script = path.join(repositoryRoot, 'e2e/journey/journey_resources.py');
  const result = spawnSync('python3', [script, '--toolchain-contract'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `runner toolchain contract exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function resolveImageArguments(image, globalArgs, declaredArgs) {
  const externalArgs = new Set();
  const resolvedImage = image.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    const name = braced ?? bare;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !declaredArgs.has(name)) {
      throw new Error(`FROM image ${JSON.stringify(image)} uses an undeclared ARG or variable`);
    }
    if (globalArgs.has(name)) return globalArgs.get(name);
    externalArgs.add(name);
    return match;
  });
  return { image: resolvedImage, externalArgs: [...externalArgs].sort() };
}

function dockerfileEscapeCharacter(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('#')) break;
    const directive = /^#\s*escape\s*=\s*([`\\])\s*$/i.exec(trimmed);
    if (directive) return directive[1];
  }
  return '\\';
}

function endsWithUnescaped(instruction, escape) {
  let count = 0;
  for (let index = instruction.length - 1; index >= 0 && instruction[index] === escape; index -= 1) count += 1;
  return count % 2 === 1;
}
