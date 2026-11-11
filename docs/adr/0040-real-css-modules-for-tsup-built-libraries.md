# ADR-0040: Real CSS Modules for tsup-built Studio libraries

**Date:** 2026-08-17
**Status:** Accepted
**Deciders:** KB Labs Team
**Tags:** studio, tooling, dx, conventions

## Context

`@kb-labs/studio-ui-kit` (and any other Studio library built with the shared
`react-lib` tsup preset) authors component styles as CSS Modules —
`import styles from './X.module.css'`, `className={styles.foo}`. esbuild, which
tsup uses under the hood, has no built-in CSS Modules support: a bare
`.module.css` default import always resolves to `{}` at build time. Every
`styles.foo` reference in the published `dist/` output was therefore
`undefined`, and the corresponding CSS rule never applied to any DOM node.

This was silent. Typecheck passes (the ambient `declare module '*.module.css'`
type is `Record<string, string>`, matching either a real or an empty object).
The build succeeds and even emits a `dist/index.css` with the literal,
unscoped selectors from source — so at a glance the pipeline looks correct.
The failure only shows up at runtime, as a missing `className`, and is easy to
mistake for "this component doesn't have that variant" rather than "the class
map is empty."

One component (`UITag`) had already hit this and worked around it locally: a
comment in `UITag.module.css` explains that `styles.className` is always `{}`,
and the component switched to a side-effect CSS import plus hardcoded literal
class strings (`'kb-ui-tag'`, `'kb-ui-tag--clickable'`). Five other components
(`UICard`, `UIShimmerText`, `UIIcon`, `UISkeleton`, `UIButton`) still used the
broken `styles.foo` pattern and had never been noticed — their CSS Modules
classes, including a loading-skeleton shimmer animation, were dead code.

Studio itself is not short of CSS Modules infrastructure — it already has two
independent, correctly-working implementations, discovered while scoping this
fix:

- The Studio host (`studio/app/rspack.config.mjs`) uses Rspack's native CSS
  support (`experiments.css`, `type: 'css/auto'`), with
  `exportsConvention: 'as-is'` — class names are kept as authored, not
  camelCased.
- Plugin Module Federation remotes (`studio/plugin-tools`, used by every
  `plugins/*` Studio widget) use `css-loader` + `style-loader` with
  `modules: true`. `@kb-labs/studio-ui-kit` itself is excluded from this path
  — it's a Module Federation `singleton: true` shared dependency, loaded once
  by the host, not bundled per-remote — so this rule only ever applies to a
  plugin's own local `.module.css` files (e.g. `services/workflow/entry`'s
  artifact viewers).

Neither of those is reachable from tsup/esbuild; a different bundler needs its
own implementation. But the convention they've already settled on —
`as-is` naming, real per-file scoping — is worth matching rather than
inventing a third, inconsistent one.

## Decision

Add a small esbuild plugin, `infra/devkit/tsup/css-modules-plugin.js`, wired
into the shared `react-lib` tsup preset via `esbuildPlugins`. It runs
`.module.css` files through `postcss-modules`, so `styles.foo` resolves to a
real, collision-safe class name and the scoped CSS is still bundled into the
package's output stylesheet.

Naming convention: `generateScopedName: '[local]_[hash:base64:5]'` — keys stay
as-authored (matching the host's `exportsConvention: 'as-is'`), values are
`<local>_<hash>` so class names stay legible in devtools while remaining
scoped per file.

Ant Design's own classes referenced from component CSS (`.ant-btn-primary`,
`.ant-btn-icon`, `.anticon`, etc.) are wrapped in `:global(...)` at the CSS
source level. Without this, postcss-modules scopes *every* class in the file
by default, including ones that must match real, unscoped Ant Design DOM
classes — silently breaking hover/press feedback and icon theming instead of
fixing anything.

`studio-plugin-tools`'s existing `css-loader` config is made to declare
`modules: { exportLocalsConvention: 'as-is' }` explicitly, rather than
relying on css-loader's version-dependent default (v7 happens to default to
`as-is` already when `esModule`/`namedExport` are on, but that's an implicit,
fragile alignment).

All CSS Modules consumers use [`clsx`](https://github.com/lukeed/clsx) to
build conditional class strings, replacing ad hoc
`[...].filter(Boolean).join(' ')`. `UITag`'s hardcoded-literal workaround is
reverted back to a normal `styles.foo` + `clsx` import now that the underlying
tsup limitation is fixed — a component-local escape hatch does not need to
outlive the problem it worked around.

### A build-tooling gotcha worth recording

esbuild plugin `onLoad` handlers that omit a `namespace` filter match *every*
namespace, not just the default `file` namespace. tsup registers its own
`postcss` plugin with `onLoad({ filter: /\.css$/ })` and no namespace
restriction, ahead of any user-supplied `esbuildPlugins`. An earlier version
of this plugin moved `.module.css` imports into a custom namespace but kept a
path that still *looked* like `*.module.css` — tsup's handler matched it
anyway, by extension, regardless of namespace, and won the race by running
first. The fix: virtual resolved paths carry a `?kb-css-modules-*` query
suffix so they no longer end in `.css` at all, and can't be accidentally
reclaimed by an unrelated `/\.css$/` filter.

## Consequences

### Positive

- `UICard`, `UIShimmerText`, `UIIcon`, `UISkeleton`, `UIButton` now actually
  apply the styles their source already described — including the loading
  skeleton's shimmer animation, previously dead code.
- Class names are real and collision-scoped instead of relying on every
  author picking a globally-unique literal string by hand (`UITag`'s old
  approach), while staying human-readable in devtools.
- One documented convention (`as-is`, hashed suffix) across the Studio host,
  plugin remotes, and tsup-built libraries, instead of three implicit ones.
- `clsx` gives a consistent, less error-prone way to compose conditional
  class names project-wide.

### Negative

- tsup-built Studio libraries now depend on `postcss` and `postcss-modules`
  at build time (added to `infra/devkit`'s own dependencies, not the
  consumer's).
- Every future `.module.css` rule targeting an Ant Design or other
  third-party class must remember `:global(...)`, or that rule silently stops
  matching. This is not statically checked — it's a convention, documented
  here and in the plugin's source comment.
- One more piece of custom build tooling to maintain, versus e.g. depending on
  a ready-made `esbuild-css-modules-plugin` package (not evaluated in detail;
  our plugin is ~80 lines and gives full control over the naming convention
  needed to match the Rspack side).

### Alternatives Considered

- **Keep the `UITag`-style literal-string workaround, applied everywhere.**
  Rejected per explicit direction: it gives up real per-file isolation, which
  is the property actually wanted, in exchange for avoiding new build
  tooling.
- **Switch `.module.css` to plain `.css` project-wide, drop the CSS Modules
  convention entirely.** Same rejection — isolation was the point.
- **Fix CSS Modules only for the specific broken components, without shared
  tooling.** Rejected: the next tsup-built library with a `.module.css` file
  hits the exact same silent failure. A shared preset-level fix is the only
  way this doesn't recur.

## Implementation

- `infra/devkit/tsup/css-modules-plugin.js` (new) — the esbuild plugin.
- `infra/devkit/tsup/react-lib.js` — wires it in via `esbuildPlugins`.
- `infra/devkit/package.json` — adds `postcss` and `postcss-modules`
  dependencies, exports the new plugin path.
- `studio/ui-kit/src/core/{UICard,UIShimmerText,UIIcon,UIButton,UITag}.tsx`,
  `studio/ui-kit/src/feedback/UISkeleton.tsx` — real `styles.foo` imports +
  `clsx`.
- `studio/ui-kit/src/core/{UIButton,UIIcon}.module.css` — `:global(...)`
  wrapping for Ant Design classes.
- `studio/ui-kit/package.json` — adds `clsx` dependency.
- `studio/plugin-tools/src/index.ts` — explicit
  `exportLocalsConvention: 'as-is'` on the existing `css-loader` rule.

Any future tsup-built package that introduces `.module.css` files gets this
for free by extending `@kb-labs/devkit/tsup/react-lib`. No other action is
required; the plugin's own source comment carries the namespace/`.css`-suffix
gotcha for the next person who touches it.

## References

- [studio/app/rspack.config.mjs](../../studio/app/rspack.config.mjs) — native
  Rspack CSS Modules convention this decision matches.
- [studio/plugin-tools/src/index.ts](../../studio/plugin-tools/src/index.ts)
  — plugin-remote `css-loader` convention, aligned by this decision.

---

**Last Updated:** 2026-08-17
