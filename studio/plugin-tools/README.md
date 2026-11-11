# @kb-labs/studio-plugin-tools

Build tooling for Studio plugin pages (Module Federation remotes).
Uses Rspack with `@module-federation/enhanced` for native MF support.

## Usage

```typescript
// rspack.studio.config.mjs
import { createStudioRemoteConfig } from '@kb-labs/studio-plugin-tools';

export default await createStudioRemoteConfig({
  name: 'myPlugin',
  exposes: {
    './MyPage': './src/studio/pages/MyPage.tsx',
  },
});
```

## Plugin page conventions

- `export default function MyPage() { ... }` — **default export only**, no named export of the same component
- Import all UI from `@kb-labs/sdk/studio` — never from `@kb-labs/studio-ui-kit` directly
- No top-level side effects in the page module

## Available hooks

All hooks are available via `import { ... } from '@kb-labs/sdk/studio'`:

| Hook | Purpose |
|------|---------|
| `useData<T>(endpoint, opts?)` | REST GET with caching and polling |
| `useMutateData<I,O>(endpoint, method?)` | REST POST/PUT/PATCH/DELETE mutations |
| `useSSE<T>(endpoint, opts?)` | Server-sent events with reconnect |
| `useInfiniteData<T>(endpoint, opts)` | Cursor/offset pagination |
| `useWebSocket<S,R>(url, opts?)` | Bidirectional WebSocket |
| `useEventBus()` | Cross-plugin pub/sub communication |
| `usePermissions()` | Permission checks |
| `useNavigation()` | Programmatic routing |
| `useNotification()` | Toast/alert notifications |
| `useTheme()` | Design tokens and theme mode |
| `usePage()` | Page context (pageId, pluginId, permissions) |

---

## Troubleshooting

### `Objects are not valid as a React child` / `mountIndeterminateComponent`

**Symptom:** Plugin page crashes immediately on first load with one of:
- `Objects are not valid as a React child (found: object with keys {$$typeof, type, key, ref, props})`
- `TypeError: Cannot read properties of null (reading 'useRef')`
- Error points to `mountIndeterminateComponent` in the host's `main.js`

These errors all mean one thing: **React version mismatch** between the plugin bundle and the Studio host.

**Root cause — React 19 bundled into the plugin:**

pnpm resolves `"react": ">=18.0.0"` (from peer deps) to the latest available React, which may be **React 19**. Module Federation requires all remotes to share the **same** React version as the host (which uses React 18). When React 19 code ends up in the plugin bundle, `Symbol.for("react.transitional.element")` is used instead of `Symbol.for("react.element")`, and elements from one React can't be reconciled by the other.

**`createStudioRemoteConfig` catches this at build time:**

Since v0.1.x, `createStudioRemoteConfig` validates the resolved React version before building. If React 19 is detected, the build fails immediately with a clear error:

```
❌ Studio plugin build failed: React 19.x.x detected.

Studio host runs React 18. When a plugin bundles React 19, elements use
Symbol.for('react.transitional.element') which React 18 cannot reconcile,
causing "Objects are not valid as a React child" crash at runtime.

Fix: pin React 18 in your plugin's devDependencies: ...
```

**Fix:** Pin React 18 in `devDependencies` of the plugin's CLI package:

```json
// packages/my-plugin-cli/package.json
{
  "devDependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
```

Then reinstall and rebuild the widget:

```bash
pnpm --filter @kb-labs/my-plugin-cli install
pnpm --filter @kb-labs/my-plugin-cli run build:studio
```

**Reference plugins:** `@kb-labs/commit/cli`, `@kb-labs/agents/cli` — both pin `react@^18.3.1` in devDependencies.

---

### `Objects are not valid as a React child` — stale ui-kit dist

**Symptom:** Plugin crashes after ui-kit source was changed, but `studio-ui-kit` dist was not rebuilt.

The Studio dev server serves `@kb-labs/studio-ui-kit` from its **compiled dist** (`dist/index.js`), not from TypeScript source. Plugins also bundle a fallback copy of ui-kit from the same dist. If the source is fixed but the dist is stale, both the host's shared scope and the plugin's fallback bundle serve the old broken code.

A SubComponent alias like `export const UIDescriptionsItem = AntDescriptions.Item` compiles to an antd internal object — not a React function component. When React tries to render `<UIDescriptionsItem />`, it receives this object as the component type and throws.

**Fix:** Rebuild `studio-ui-kit` dist, then restart Studio:

```bash
pnpm --filter @kb-labs/studio-ui-kit build
kb-dev restart studio
```

**Rule:** Any time you change `studio-ui-kit` source, you must rebuild its dist before changes are visible.

---

### Plugin navigation — error from previous plugin "leaks" to next

**Symptom:** Navigating from a broken plugin page to a working one — the working page shows the same crash error. Clicking Retry fixes it.

**Root cause:** `PageErrorBoundary` is a class component that holds error state. Without a `key` prop on `PageContainer`, React reuses the same boundary instance between routes and the error state persists.

**Fix:** Already applied in `plugin-page-v2.tsx` — `PageContainer` renders with `key={`${plugin.remoteName}::${page.entry}`}` so React fully unmounts/remounts on navigation.

---

### Double export causes MF bundling issues

**Symptom:** Plugin page crashes with component type errors.

**Wrong:**
```tsx
export function MyPage() { ... }   // named export
export default MyPage;             // + default export of same component
```

**Right:**
```tsx
function MyPage() { ... }          // no named export
export default MyPage;
```

MF expose bundles the module graph starting from the exposed entry. A named export of the same component can confuse the bundler into including two instances of the component in different chunks.
