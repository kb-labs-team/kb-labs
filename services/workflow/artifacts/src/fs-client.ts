import { createWriteStream, createReadStream } from 'node:fs'
import { lstat, mkdir, stat, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { isAbsolute, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { dirname, resolve, join, relative, basename } from 'pathe'
import type {
  ArtifactClient,
  ArtifactInput,
  ArtifactOutput,
  ArtifactReference,
} from './types'

function ensureWithinRoot(root: string, targetPath: string): string {
  const normalizedRoot = resolve(root)
  const target = resolve(normalizedRoot, targetPath)
  const relativeTarget = relative(normalizedRoot, target)
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw new Error(`Artifact path escapes root: ${targetPath}`)
  }
  return target
}

async function ensureSafeArtifactParent(root: string, target: string, trustedRoot = root): Promise<string> {
  const normalizedTrustedRoot = resolve(trustedRoot)
  const trustedInfo = await lstat(normalizedTrustedRoot)
  if (trustedInfo.isSymbolicLink() || !trustedInfo.isDirectory()) {
    throw new Error('Artifact trusted root must be a real directory')
  }
  const canonicalRoot = await realpath(normalizedTrustedRoot)
  const normalizedRoot = resolve(root)
  const rootFromTrusted = relative(normalizedTrustedRoot, normalizedRoot)
  if (rootFromTrusted === '..' || rootFromTrusted.startsWith(`..${sep}`) || isAbsolute(rootFromTrusted)) {
    throw new Error('Artifact root escapes trusted root')
  }
  const parent = dirname(target)
  const relativeParent = relative(normalizedTrustedRoot, parent)
  if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
    throw new Error('Artifact parent escapes root')
  }

  let current = normalizedTrustedRoot
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, segment)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    }
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Artifact path contains a symbolic link or non-directory')
    }
    const canonicalCurrent = await realpath(current)
    const fromRoot = relative(canonicalRoot, canonicalCurrent)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('Artifact path resolves outside root')
    }
  }
  return parent
}

async function writeInput(
  destination: string,
  input: ArtifactInput,
): Promise<void> {
  if (
    typeof input === 'string' ||
    input instanceof Buffer ||
    input instanceof Uint8Array
  ) {
    await createParentDir(destination)
    await writeFile(destination, input)
    return
  }

  if (input && typeof input.pipe === 'function') {
    await createParentDir(destination)
    await pipeline(input, createWriteStream(destination))
    return
  }

  throw new Error('Unsupported artifact input type')
}

async function createParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
}

async function walk(root: string, prefix?: string): Promise<ArtifactReference[]> {
  const base = prefix ? ensureWithinRoot(root, prefix) : root
  const entries = await readdir(base, { withFileTypes: true })

  // Process all entries in parallel
  const entryPromises = entries.map(async (entry) => {
    const absolute = join(base, entry.name)
    const rel = relative(root, absolute)

    if (entry.isDirectory()) {
      return walk(root, rel)
    } else if (entry.isFile()) {
      const s = await stat(absolute)
      return [{
        path: rel,
        size: s.size,
        modifiedAt: s.mtime,
      }]
    }
    return []
  })

  const nestedResults = await Promise.all(entryPromises)
  return nestedResults.flat()
}

export interface FileSystemArtifactClientOptions {
  root: string
  trustedRoot?: string
  defaultContentType?: string
}

export class FileSystemArtifactClient implements ArtifactClient {
  constructor(private readonly options: FileSystemArtifactClientOptions) {}

  basePath(): string {
    return this.options.root
  }

  async produce(path: string, input: ArtifactInput): Promise<void> {
    const target = ensureWithinRoot(this.options.root, path)
    await writeInput(target, input)
  }

  async produceAtomic(path: string, input: ArtifactInput): Promise<void> {
    const target = ensureWithinRoot(this.options.root, path)
    const parent = dirname(target)
    await ensureSafeArtifactParent(this.options.root, target, this.options.trustedRoot)
    try {
      const existing = await lstat(target)
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error('Artifact target must be a regular file')
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
    const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`)
    try {
      const destination = createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
      if (typeof input === 'string' || input instanceof Buffer || input instanceof Uint8Array) {
        await pipeline(Readable.from([input]), destination)
      } else if (input && typeof input.pipe === 'function') {
        await pipeline(input, destination)
      } else {
        throw new Error('Unsupported artifact input type')
      }
      await ensureSafeArtifactParent(this.options.root, target, this.options.trustedRoot)
      try {
        const existing = await lstat(target)
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error('Artifact target must be a regular file')
        }
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  async consume(path: string): Promise<ArtifactOutput> {
    const target = ensureWithinRoot(this.options.root, path)
    return readFile(target)
  }

  async stream(path: string): Promise<NodeJS.ReadableStream> {
    const target = ensureWithinRoot(this.options.root, path)
    return createReadStream(target)
  }

  async list(prefix?: string): Promise<ArtifactReference[]> {
    return walk(this.options.root, prefix)
  }
}

export function createFileSystemArtifactClient(
  root: string,
  options?: { trustedRoot?: string },
): FileSystemArtifactClient {
  return new FileSystemArtifactClient({ root, ...options })
}


