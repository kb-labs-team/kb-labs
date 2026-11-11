import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PlatformLayoutContractError } from '@kb-labs/core-platform';

interface PlatformLayoutContract {
  platformDataRoot?: {
    platformPath?: string;
    statePath?: string;
  };
}

/** Resolve the platform data projection from the Go-owned layout contract. */
export async function resolvePlatformDataRoot(platformRoot: string, development?: boolean): Promise<string> {
  const versionContractPath = path.join(platformRoot, '.kb/v2/platform-layout.json');
  const installRoot = development === true ? undefined : await findInstallRoot(platformRoot);
  const activeContractPath = path.join(installRoot ?? platformRoot, 'current/.kb/v2/platform-layout.json');
  const developmentContractPath = path.join(platformRoot, 'tools/kb-create/v2/contracts/platform-layout.json');
  const contractPath = development === true
    ? developmentContractPath
    : installRoot && path.resolve(platformRoot) === path.resolve(installRoot)
      ? activeContractPath
      : await selectVersionLayoutContract(versionContractPath, activeContractPath, developmentContractPath, development);
  const installed = contractPath !== developmentContractPath;
  const contractRoot = contractPath === activeContractPath ? path.join(installRoot ?? platformRoot, 'current') : platformRoot;
  let contract: PlatformLayoutContract;
  try {
    contract = JSON.parse(await fs.readFile(contractPath, 'utf8')) as PlatformLayoutContract;
  } catch (error) {
    if (installRoot && isMissingPath(error)) {
      throw new PlatformLayoutContractError(activeContractPath, installRoot);
    }
    throw new Error(`Cannot read platform data-root layout contract at ${contractPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const platformPath = contract.platformDataRoot?.platformPath;
  const statePath = contract.platformDataRoot?.statePath;
  if (!platformPath || !statePath || path.isAbsolute(platformPath) || path.isAbsolute(statePath)) {
    throw new Error(`Platform layout contract at ${contractPath} has no valid platformDataRoot paths.`);
  }
  const projection = path.resolve(contractRoot, platformPath);
  if (!installed) {return projection;}
  try {
    return await fs.realpath(projection);
  } catch (error) {
    throw new Error(`Cannot resolve platform data-root projection ${projection}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function selectVersionLayoutContract(versionContractPath: string, activeContractPath: string, developmentContractPath: string, development?: boolean): Promise<string> {
  try {
    await fs.access(activeContractPath);
    return activeContractPath;
  } catch (error) {
    if (!isMissingPath(error)) {throw error;}
  }
  try {
    await fs.access(versionContractPath);
    return versionContractPath;
  } catch (error) {
    if (!isMissingPath(error)) {throw error;}
  }
  if (development !== false) {
    try {
      await fs.access(developmentContractPath);
      return developmentContractPath;
    } catch (error) {
      if (!isMissingPath(error)) {throw error;}
    }
  }
  return versionContractPath;
}

async function findInstallRoot(root: string): Promise<string | undefined> {
  let candidate = path.resolve(root);
  while (true) {
    if (await hasInstallRootStructure(candidate)) {return candidate;}
    const parent = path.dirname(candidate);
    if (parent === candidate) {return undefined;}
    candidate = parent;
  }
}

async function hasInstallRootStructure(root: string): Promise<boolean> {
  for (const child of ['current', 'versions']) {
    try {
      await fs.access(path.join(root, child));
      return true;
    } catch (error) {
      if (!isMissingPath(error)) {throw error;}
    }
  }
  return false;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
