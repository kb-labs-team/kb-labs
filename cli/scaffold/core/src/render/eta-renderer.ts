import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Eta } from 'eta';
import type {
  RenderContext,
  RenderedFile,
} from '@kb-labs/scaffold-contracts';

const eta = new Eta({
  autoEscape: false,
  useWith: true,
  tags: ['<%', '%>'],
});

const ETA_SUFFIX = '.eta';

/**
 * Render a single template string through eta using the given context.
 */
export function renderString(template: string, ctx: RenderContext): string {
  return eta.renderString(template, ctx);
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(p)));
    } else if (entry.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function renderPath(relPath: string, ctx: RenderContext): string {
  // Use simple __var__ substitution for path segments — eta's `<% %>`
  // tags are illegal on Windows and awkward on Unix.
  const substituted = relPath
    .replace(/__name__/g, ctx.name)
    .replace(/__scope__/g, ctx.scope.replace(/^@/, ''));
  return substituted.endsWith(ETA_SUFFIX)
    ? substituted.slice(0, -ETA_SUFFIX.length)
    : substituted;
}

/**
 * Render all files under `filesDir`. File bodies AND path segments go through
 * eta. A trailing `.eta` extension on the file name is stripped after render.
 *
 * Returned paths are relative to `filesDir`. The caller decides the output root.
 */
const SKIP_MARKER = '<!--@@scaffold:skip@@-->';

export async function renderFilesDir(
  filesDir: string,
  ctx: RenderContext,
): Promise<RenderedFile[]> {
  const absolutes = await walk(filesDir);
  const rendered: RenderedFile[] = [];
  for (const abs of absolutes) {
    const rel = relative(filesDir, abs);
    const renderedRel = renderPath(rel, ctx);
    const raw = await readFile(abs, 'utf8');
    const body = abs.endsWith(ETA_SUFFIX)
      ? renderString(raw, ctx)
      : raw;

    // Templates can opt out of a given file by emitting a skip marker.
    // Useful for files that should only exist in some modes (e.g.
    // pnpm-workspace.yaml only for standalone mode).
    if (body.trim() === SKIP_MARKER) {continue;}

    const st = await stat(abs);
    rendered.push({
      path: renderedRel,
      contents: body,
      executable: (st.mode & 0o111) !== 0,
    });
  }
  return rendered;
}
