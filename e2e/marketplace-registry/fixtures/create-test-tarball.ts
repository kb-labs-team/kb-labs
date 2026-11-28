import { gzipSync } from 'node:zlib'

export interface TarballOptions {
  /**
   * Also include a `kb.plugin.json` so the package is a recognizable KB Labs
   * entity. Required for marketplace install, which rejects non-entity packages
   * with HTTP 422 (B-021). Pass `true` to derive a minimal ManifestV3 from
   * pkgJson, or an explicit manifest object to control its contents.
   */
  manifest?: true | Record<string, unknown>
}

/**
 * Builds a minimal valid tar.gz for a package. By default it contains only a
 * package.json (enough for registry publish/fetch tests). Pass `opts.manifest`
 * to also emit a `kb.plugin.json` so marketplace install accepts it as an entity.
 */
export function createTestTarball(
  pkgJson: Record<string, unknown>,
  opts: TarballOptions = {},
): Buffer {
  const files: Array<{ name: string; content: Buffer }> = [
    { name: 'package/package.json', content: Buffer.from(JSON.stringify(pkgJson, null, 2)) },
  ]

  if (opts.manifest) {
    const manifest = opts.manifest === true ? defaultManifest(pkgJson) : opts.manifest
    files.push({
      name: 'package/kb.plugin.json',
      content: Buffer.from(JSON.stringify(manifest, null, 2)),
    })
  }

  const blocks: Buffer[] = []
  for (const file of files) {
    blocks.push(buildTarHeader(file.name, file.content.length))
    blocks.push(padTo512(file.content))
  }
  blocks.push(Buffer.alloc(1024)) // two 512-byte zero blocks = end-of-archive

  return gzipSync(Buffer.concat(blocks))
}

/** Identity used in a fixture manifest for a package name. */
export function testManifestIdentity(name: string): string {
  return name.startsWith('@') ? name : `@e2e/${name}`
}

/** Minimal valid ManifestV3 derived from the package metadata. */
function defaultManifest(pkgJson: Record<string, unknown>): Record<string, unknown> {
  const name = typeof pkgJson.name === 'string' ? pkgJson.name : 'test'
  const version = typeof pkgJson.version === 'string' ? pkgJson.version : '1.0.0'
  // Manifest id must be @scope/name; scope unscoped package names under @e2e.
  const id = testManifestIdentity(name)
  return {
    schema: 'kb.plugin/3',
    id,
    version,
    display: {
      name,
      description: typeof pkgJson.description === 'string' ? pkgJson.description : 'E2E test entity',
    },
  }
}

function buildTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)

  writeString(header, name, 0, 100)
  writeString(header, '0000644\0', 100, 8)  // mode
  writeString(header, '0000000\0', 108, 8)  // uid
  writeString(header, '0000000\0', 116, 8)  // gid
  writeString(header, size.toString(8).padStart(11, '0') + '\0', 124, 12)  // size
  writeString(header, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12)  // mtime
  header.fill(0x20, 148, 156)  // checksum placeholder (spaces)
  header[156] = 0x30  // type: regular file '0'
  writeString(header, 'ustar\0', 257, 6)
  writeString(header, '00', 263, 2)

  // compute checksum
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  writeString(header, sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)

  return header
}

function writeString(buf: Buffer, str: string, offset: number, len: number): void {
  const bytes = Buffer.from(str, 'utf8')
  bytes.copy(buf, offset, 0, Math.min(bytes.length, len))
}

function padTo512(buf: Buffer): Buffer {
  const rem = buf.length % 512
  if (rem === 0) return buf
  return Buffer.concat([buf, Buffer.alloc(512 - rem)])
}
