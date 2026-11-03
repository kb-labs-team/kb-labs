import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { cssModulesPlugin } from './css-modules-plugin.js';

/**
 * Regression coverage for infra/devkit/tsup/css-modules-plugin.js.
 *
 * Every scenario here is a real failure this plugin went through before it
 * worked (see docs/adr/0040-real-css-modules-for-tsup-built-libraries.md):
 * esbuild not touching `.module.css` at all (empty token map), and — the
 * subtle one — tsup's own bundled postcss onLoad handler racing this
 * plugin's onLoad and winning because esbuild's namespace-less filters
 * match every namespace, not just `file`.
 */

const dirs: string[] = [];

function makeFixtureDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kb-css-modules-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

/** Mimics tsup's bundled postcss plugin: an onLoad for /\.css$/ with no namespace filter. */
const competingNamespaceLessCssLoader: esbuild.Plugin = {
  name: 'competing-css-loader',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const { readFile } = await import('node:fs/promises');
      return { contents: await readFile(args.path, 'utf8'), loader: 'css' };
    });
  },
};

async function bundle(dir: string, extraPlugins: esbuild.Plugin[] = []) {
  const result = await esbuild.build({
    entryPoints: [path.join(dir, 'entry.js')],
    bundle: true,
    write: false,
    outdir: path.join(dir, 'out'),
    format: 'esm',
    plugins: [...extraPlugins, cssModulesPlugin()],
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  return { js, css };
}

describe('cssModulesPlugin', () => {
  it('resolves styles.<class> to a real, non-empty scoped class name', async () => {
    const dir = makeFixtureDir();
    writeFileSync(path.join(dir, 'entry.js'), `
      import styles from './x.module.css';
      export const cls = styles.foo;
    `);
    writeFileSync(path.join(dir, 'x.module.css'), `.foo { color: red; }`);

    const { js, css } = await bundle(dir);

    // The pre-fix behavior: esbuild has no CSS Modules support, so a bare
    // `.module.css` default import resolves to `{}` and every className is
    // silently undefined at runtime.
    expect(js).not.toContain('= {};');
    expect(js).toMatch(/var \w+_default = \{\s*"foo":\s*"foo_[\w-]+"\s*\};/);

    const match = js.match(/"foo":\s*"(foo_[\w-]+)"/);
    expect(match).not.toBeNull();
    const scopedName = match![1];

    expect(css).toContain(`.${scopedName} {`);
    expect(css).not.toContain('.foo {'); // original literal selector must not survive unscoped
  });

  it('keeps :global(...) selectors as real, unscoped Ant Design class names', async () => {
    const dir = makeFixtureDir();
    writeFileSync(path.join(dir, 'entry.js'), `
      import styles from './btn.module.css';
      export const cls = styles.uiButton;
    `);
    writeFileSync(
      path.join(dir, 'btn.module.css'),
      `.uiButton:global(.ant-btn-primary) { color: blue; }`,
    );

    const { css } = await bundle(dir);

    // The real (unscoped) Ant Design class must appear verbatim so it still
    // matches Ant Design's actual rendered DOM class.
    expect(css).toContain('.ant-btn-primary');
    // ...while the local part of the same compound selector is still scoped.
    expect(css).not.toMatch(/\.uiButton(?!_[\w-])/);
  });

  it('rewrites @keyframes and their animation-name reference to the same scoped name', async () => {
    const dir = makeFixtureDir();
    writeFileSync(path.join(dir, 'entry.js'), `import './anim.module.css';`);
    writeFileSync(
      path.join(dir, 'anim.module.css'),
      `
      .spin { animation: spin 1s linear infinite; }
      @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
      `,
    );

    const { css } = await bundle(dir);

    const keyframesMatch = css.match(/@keyframes (spin_[\w-]+)/);
    expect(keyframesMatch).not.toBeNull();
    const scopedKeyframesName = keyframesMatch![1];

    expect(css).toContain(`animation: ${scopedKeyframesName} 1s linear infinite;`);
  });

  it('still resolves real tokens when a namespace-less onLoad(/\\.css$/) plugin runs first', async () => {
    // Regression test for the actual bug hit while building this plugin:
    // tsup registers a `.css` onLoad with no namespace restriction, ahead of
    // any user esbuildPlugins. esbuild's namespace-less onLoad filters match
    // every namespace — not just `file` — so an earlier version of this
    // plugin that resolved `.module.css` into a custom namespace, but kept a
    // path that still *looked* like `*.module.css`, was silently intercepted
    // by that competing handler before ever reaching postcss-modules.
    const dir = makeFixtureDir();
    writeFileSync(path.join(dir, 'entry.js'), `
      import styles from './race.module.css';
      export const cls = styles.foo;
    `);
    writeFileSync(path.join(dir, 'race.module.css'), `.foo { color: green; }`);

    const { js } = await bundle(dir, [competingNamespaceLessCssLoader]);

    expect(js).not.toContain('= {};');
    expect(js).toMatch(/"foo":\s*"foo_[\w-]+"/);
  });

  it('produces stable, deterministic scoped names across repeated builds of the same file', async () => {
    const dir = makeFixtureDir();
    writeFileSync(path.join(dir, 'entry.js'), `
      import styles from './stable.module.css';
      export const cls = styles.foo;
    `);
    writeFileSync(path.join(dir, 'stable.module.css'), `.foo { color: red; }`);

    const first = await bundle(dir);
    const second = await bundle(dir);

    const extract = (js: string) => js.match(/"foo":\s*"(foo_[\w-]+)"/)?.[1];
    expect(extract(first.js)).toBe(extract(second.js));
  });
});
