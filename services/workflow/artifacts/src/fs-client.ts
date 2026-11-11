import { createWriteStream, createReadStream } from 'node:fs'
import { mkdir, stat, readdir, readFile, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { dirname, resolve, join, relative } from 'pathe'
import type {
  ArtifactClient,
  ArtifactInput,
  ArtifactOutput,
  ArtifactReference,
} from './types'

function ensureWithinRoot(root: string, targetPath: string): string {
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`
  const target = resolve(root, targetPath)
  if (target === normalizedRoot.slice(0, -1)) {
    return target
  }
  if (!target.startsWith(normalizedRoot)) {
    throw new Error(`Artifact path escapes root: ${targetPath}`)
  }
  return target
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
): FileSystemArtifactClient {
  return new FileSystemArtifactClient({ root })
}


