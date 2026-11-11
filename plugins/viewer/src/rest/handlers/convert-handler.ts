import { parseViewerInput } from '../validation.js';
import { viewerConvertQuerySchema } from '../schemas.js';
import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSourceRoot, resolveInside } from '../../core/index.js';

const execFileAsync = promisify(execFile);

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ path: string; source?: string }>) {
    const query = parseViewerInput(viewerConvertQuerySchema, input.query ?? {});
    const relative = query.path;
    const root = await resolveSourceRoot(ctx.cwd, query.source);
    const source = await resolveInside(root, relative);
    const sourceStat = await stat(source);
    if (sourceStat.size > 30 * 1024 * 1024) {throw new Error('Office documents larger than 30 MB cannot be converted');}
    const temp = await mkdtemp(path.join(os.tmpdir(), 'kb-viewer-'));
    const profile = `file://${path.join(temp, `profile-${randomUUID()}`)}`;
    try {
      await execFileAsync('soffice', ['--headless', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', temp, source], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
      const pdfPath = path.join(temp, `${path.basename(source, path.extname(source))}.pdf`);
      const pdfStat = await stat(pdfPath);
      if (pdfStat.size > 40 * 1024 * 1024) {throw new Error('Converted PDF exceeds 40 MB');}
      return { path: relative, pdfName: path.basename(pdfPath), data: (await readFile(pdfPath)).toString('base64') };
    } catch (error) {
      const message = error instanceof Error && error.message.includes('ENOENT')
        ? 'LibreOffice (soffice) is not available in this Studio runtime'
        : 'Could not convert this office document to PDF';
      throw new Error(message, { cause: error });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
});
