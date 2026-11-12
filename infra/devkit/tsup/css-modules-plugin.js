import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import postcssModules from 'postcss-modules';

/**
 * esbuild plugin: real CSS Modules for tsup-built libraries.
 *
 * esbuild has no built-in CSS Modules support — a bare `import styles from
 * './x.module.css'` under tsup/esbuild always resolves to `{}` (see
 * infra/devkit/tsup/react-lib.js). This plugin processes `.module.css`
 * files through postcss-modules so `styles.foo` resolves to a real,
 * collision-safe class name, and the scoped CSS still gets bundled into
 * the package's output stylesheet.
 *
 * Naming matches the Studio host's native Rspack CSS Modules convention
 * (`type: 'css/auto'`, `exportsConvention: 'as-is'` in studio/app/rspack.config.mjs)
 * as closely as a different bundler allows: keys stay as-authored (no
 * camelCasing), values are `<local>_<hash>` so class names stay readable
 * in devtools while still being scoped per file.
 *
 * Virtual resolved paths deliberately do NOT end in `.css` (they carry a
 * `?kb-css-modules-*` suffix instead). tsup registers its own postcss
 * onLoad handler for `/\.css$/` with no namespace restriction, and
 * esbuild's namespace-less onLoad filters match every namespace, not just
 * `file` — so a path that still looked like `*.module.css` after being
 * moved into our namespace was silently intercepted by tsup's handler
 * before this plugin ever got a chance to run.
 *
 * Virtual paths are relative to the build's working directory, never absolute.
 * esbuild prints a non-`file` namespace path verbatim into the bundle comment,
 * the sourcemap `sources` and the CSS, so an absolute path would embed the
 * checkout location in dist. That made dependents' cache keys (which hash
 * `^dist/**`) differ per checkout and leaked the user's home path into a
 * shared store.
 */
export function cssModulesPlugin() {
  /** @type {Map<string, { css: string, tokens: Record<string, string> }>} */
  const cache = new Map();

  /**
   * `virtualPath` is the file's path relative to the build's working
   * directory. The scoped-name hash is taken over it, not over the absolute
   * path postcss-modules would use by default, so a class name is identical in
   * every checkout. Names stay `<local>_<5 chars>`, readable in devtools.
   */
  async function process(filePath, virtualPath) {
    const cached = cache.get(filePath);
    if (cached) {
      return cached;
    }
    const source = await readFile(filePath, 'utf8');
    let tokens = {};
    const result = await postcss([
      postcssModules({
        getJSON(_from, json) {
          tokens = json;
        },
        generateScopedName: (local) => {
          const hash = createHash('sha256').update(`${virtualPath}\0${local}`).digest('base64url').slice(0, 5);
          return `${local}_${hash}`;
        },
      }),
    ]).process(source, { from: filePath, map: false });
    const entry = { css: result.css, tokens };
    cache.set(filePath, entry);
    return entry;
  }

  return {
    name: 'kb-css-modules',
    setup(build) {
      const root = build.initialOptions.absWorkingDir ?? process.cwd();
      const toVirtual = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
      const toReal = (virtual) => path.resolve(root, virtual);

      build.onResolve({ filter: /\.module\.css$/ }, (args) => ({
        path: `${toVirtual(path.isAbsolute(args.path) ? args.path : path.join(args.resolveDir, args.path))}?kb-css-modules-tokens`,
        namespace: 'kb-css-modules-tokens',
      }));

      build.onLoad({ filter: /\?kb-css-modules-tokens$/, namespace: 'kb-css-modules-tokens' }, async (args) => {
        const virtualPath = args.path.replace(/\?kb-css-modules-tokens$/, '');
        const realPath = toReal(virtualPath);
        const { tokens } = await process(realPath, virtualPath);
        return {
          // Side-effect import pulls in the scoped CSS via the paired
          // virtual-css namespace below; this module only exports tokens.
          contents: `import ${JSON.stringify(`${virtualPath}?kb-css-modules-css`)};\nexport default ${JSON.stringify(tokens)};`,
          loader: 'js',
          resolveDir: path.dirname(realPath),
        };
      });

      build.onResolve({ filter: /\?kb-css-modules-css$/ }, (args) => ({
        path: args.path,
        namespace: 'kb-css-modules-css',
      }));

      build.onLoad({ filter: /\?kb-css-modules-css$/, namespace: 'kb-css-modules-css' }, async (args) => {
        const virtualPath = args.path.replace(/\?kb-css-modules-css$/, '');
        const realPath = toReal(virtualPath);
        const { css } = await process(realPath, virtualPath);
        return { contents: css, loader: 'css', resolveDir: path.dirname(realPath) };
      });
    },
  };
}
