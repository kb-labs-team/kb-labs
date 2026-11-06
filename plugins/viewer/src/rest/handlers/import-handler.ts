import { viewerImportBodySchema } from '../schemas.js';
import { parseViewerInput } from '../validation.js';
import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { ensureSourceStorageRoot, isAllowedPackagePath, loadArchitecture, ViewerInputError } from '../../core/index.js';

const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 1000;

interface ImportBody { fileName: string; data: string }

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<never, ImportBody>) {
    const body = parseViewerInput(viewerImportBodySchema, input.body);
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length > MAX_ARCHIVE_BYTES) {throw new Error('ZIP archives larger than 24 MB cannot be imported');}
    const entries: Record<string, Uint8Array> = {};
    let totalBytes = 0;
    let fileCount = 0;
    let rejectedFiles = 0;
    const seenPaths = new Set<string>();
    const files = unzipSync(bytes, {
      filter(info) {
        const relative = info.name.replace(/\\/g, '/');
        if (path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {throw new ViewerInputError('ZIP contains an unsafe path');}
        if (relative.endsWith('/')) {return false;}
        if (seenPaths.has(relative)) {throw new ViewerInputError('ZIP contains duplicate paths');}
        seenPaths.add(relative);
        if (!isAllowedPackagePath(relative)) { rejectedFiles += 1; return false; }
        if (info.originalSize > MAX_FILE_BYTES) {throw new ViewerInputError('ZIP contains a file larger than 30 MB');}
        totalBytes += info.originalSize;
        if (totalBytes > MAX_TOTAL_BYTES || fileCount >= MAX_FILES) {throw new ViewerInputError('ZIP exceeds import limits');}
        fileCount += 1;
        return true;
      },
    });
    for (const [relative, data] of Object.entries(files)) {entries[relative] = data;}
    if (!Object.hasOwn(entries, 'architecture.yaml')) {throw new ViewerInputError('The package must contain architecture.yaml at its root');}
    const id = `pkg-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const storageRoot = await ensureSourceStorageRoot(ctx.cwd);
    const sourceRoot = path.join(storageRoot, id);
    await mkdir(sourceRoot);
    try {
      for (const [relative, data] of Object.entries(entries)) {
        if (!isAllowedPackagePath(relative)) {continue;}
        const destination = path.resolve(sourceRoot, relative);
        if (destination !== sourceRoot && !destination.startsWith(`${sourceRoot}${path.sep}`)) {throw new ViewerInputError('ZIP contains an unsafe path');}
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, data, { flag: 'wx' });
      }
      const architecture = await loadArchitecture(sourceRoot);
      return { id, title: architecture.title, fileCount: Object.keys(entries).length, rejectedFiles };
    } catch (error) {
      await rm(sourceRoot, { recursive: true, force: true });
      throw error;
    }
  },
});
