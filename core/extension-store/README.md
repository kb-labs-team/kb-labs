# @kb-labs/core-extension-store

Shared per-machine store of installed plugin/adapter versions: one immutable directory per exact
`name@version` under `$KB_HOME/store` (default `~/.kb/store`), so a version installed by one project
is reused by every other project that pins it. Design: [ADR-0048](../../docs/adr/0048-extension-model-shared-store-pin-sdk-contract.md) (D2).

```ts
import { createExtensionStore } from '@kb-labs/core-extension-store';

const store = createExtensionStore(); // honors KB_HOME
const { packageRoot, entry } = await store.resolve({
  name: '@kb-labs/commit',
  version: '2.120.1',
  kind: 'plugin',
});
// packageRoot: <KB_HOME>/store/entries/@kb-labs+commit@2.120.1/node_modules/@kb-labs/commit
```

`resolve` installs the version into the store on first use and is safe under concurrent callers
(a `store.lock` file, same protocol as `projects.json.lock`, serializes installs of the same
version). `lookup` is the read-only counterpart used by callers that must not install on their hot
path (the future discovery resolution algorithm, task 7.3) — it returns `undefined` instead.

Passing `expectedIntegrity` (a project's lock pin) makes both methods verify the entry against it
and throw `IntegrityMismatchError` (`KB_PLUGIN_INTEGRITY_MISMATCH`) on mismatch.

## Scope

This package is the store mechanics only:

- **In scope:** store layout, `entry.json` read/write, atomic install (staging directory + rename,
  `entry.json` written last), a dedicated pnpm content-addressed store (`cas/`, never the user's
  default store) so third-party dependency files dedup across entries, integrity verification, and
  a static-manifest projection captured without ever importing plugin code.
- **Out of scope (later tasks):** reading/writing `.kb/marketplace.lock` or resolving a project's pin
  against the platform lock (task 7.3, `KB_PLUGIN_STORE_MISSING`/`KB_PLUGIN_LOCK_INVALID`), the
  `kb plugin gc` command and its mark phase across every project's lock (a follow-up — this package
  never deletes an entry on its own), the SDK contract check (task 7.4), and the resolve hook that
  gives every process one copy of the platform (task 7.7, already landed as
  `@kb-labs/plugin-runtime`'s `platform-resolve`).

Failures are `ExtensionStoreError` (or its subclasses) with a stable catalog code and secret-free
`details`. Types live alongside the implementation in this package (there is no separate contracts
package yet — nothing outside `core-extension-store` needs these types before 7.3 wires the lock to it).
