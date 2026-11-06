import { parseViewerInput } from '../validation.js';
import { viewerExportQuerySchema } from '../schemas.js';
import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { isAllowedPackagePath, resolveSourceRoot } from '../../core/index.js';

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ source?: string }>) {
    const query = parseViewerInput(viewerExportQuerySchema, input.query ?? {});
    const root = await resolveSourceRoot(ctx.cwd, query.source);
    const files: Record<string, Uint8Array> = {};
    let totalBytes = 0;
    let excludedFiles = 0;
    async function walk(directory: string, relative: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const nextRelative = path.posix.join(relative, entry.name);
        if (!isAllowedPackagePath(nextRelative) || entry.isSymbolicLink()) { excludedFiles += 1; continue; }
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {await walk(absolute, nextRelative);}
        else if (entry.isFile()) {
          const size = (await stat(absolute)).size;
          totalBytes += size;
          if (totalBytes > 100 * 1024 * 1024 || Object.keys(files).length >= 2000) {throw new Error('Architecture package exceeds export limits');}
          files[nextRelative] = await readFile(absolute);
        }
      }
    }
    await walk(root, '');
    const archive = zipSync(files, { level: 6 });
    return { fileName: 'kb-labs-architecture.zip', fileCount: Object.keys(files).length, excludedFiles, data: Buffer.from(archive).toString('base64') };
  },
});
