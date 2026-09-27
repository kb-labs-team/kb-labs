/**
 * @module @kb-labs/plugin-runtime/platform-resolve
 *
 * One copy of the platform at runtime (ADR-0048 D5).
 *
 * A plugin loaded from outside the platform root (a shared store entry, a
 * project-local install) resolves `@kb-labs/*` platform packages from its own
 * location, which can be a private nested copy: class identity, `instanceof` and
 * error classes would then differ from the host's. This synchronous
 * `module.registerHooks` resolve hook maps every platform-package import made by
 * code outside the platform root to the host's copy, for ESM `import` and CJS
 * `require` alike. It applies to the thread that registers it: a worker thread
 * must call {@link installPlatformResolveHook} itself.
 *
 * Requires Node >= 22.15 / 23.5 (`module.registerHooks`); the repository's
 * `engines` minimum is Node 24.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, registerHooks, type ResolveFnOutput, type ResolveHookContext } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IContextLogger } from '@kb-labs/core-platform';
import { PlatformDuplicateError } from './errors.js';
import { platformPackageOf } from './platform-package.js';

/** A plugin's own copy of a platform package was replaced by the host's copy. */
export interface PlatformOverrideDiagnostic {
  /** Package (or file, when it has no package.json) that made the import. */
  plugin: string;
  requester: string;
  specifier: string;
  package: string;
  ownCopy: string;
  hostCopy: string;
}

export interface PlatformResolveHookOptions {
  /**
   * Platform installation (or workspace) root. Code under it is part of the
   * platform and is never rewritten; code outside it gets the host's copy.
   */
  platformRoot: string;
  /**
   * Extra files or `file:` URLs the host's copy is resolved from, after
   * `platformRoot`. Pass the host entrypoint (`import.meta.url`).
   */
  anchors?: readonly string[];
  /** Receives one structured `warn` event per overridden nested copy. */
  logger?: Pick<IContextLogger, 'event'>;
}

export interface PlatformResolveHook {
  readonly platformRoot: string;
  /** Removes the hook and allows a later install (tests, worker shutdown). */
  deregister(): void;
}

let installed: PlatformResolveHook | undefined;

function toFileUrl(anchor: string): string {
  return anchor.startsWith('file:') ? anchor : pathToFileURL(anchor).href;
}

function isInside(root: string, file: string): boolean {
  return file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);
}

function urlToPath(url: string): string | undefined {
  return url.startsWith('file:') ? fileURLToPath(url) : undefined;
}

/** Nearest package.json name above `file`, for diagnostics only. */
function packageLabel(file: string): string {
  let dir = dirname(file);
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
        if (typeof name === 'string') {
          return name;
        }
      } catch {
        // An unreadable manifest only costs the label; fall back to the file.
      }
      return file;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return file;
    }
    dir = parent;
  }
}

/**
 * Resolves `specifier` as if `anchor` imported it. The ESM default resolver
 * honours `parentURL`; the CJS one resolves against the requiring module and
 * ignores it, so `require` goes through `createRequire` (same `require`
 * export conditions) and answers with the resolved file.
 */
function resolveFrom(
  anchor: string,
  specifier: string,
  context: ResolveHookContext,
  nextResolve: (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput,
): ResolveFnOutput {
  if (!context.conditions.includes('require')) {
    return nextResolve(specifier, { ...context, parentURL: anchor });
  }
  const file = createRequire(anchor).resolve(specifier);
  return { url: pathToFileURL(file).href, shortCircuit: true };
}

/**
 * Installs the process-wide platform resolve hook. Idempotent for the same
 * `platformRoot` (a host and a module started inside it may both call this);
 * a different root while one is installed is an error, because one process has
 * one platform.
 */
export function installPlatformResolveHook(options: PlatformResolveHookOptions): PlatformResolveHook {
  const platformRoot = realpathSync(options.platformRoot);
  if (installed) {
    if (installed.platformRoot !== platformRoot) {
      throw new Error(
        `A platform resolve hook is already installed for "${installed.platformRoot}"; one process has one platform, cannot install it for "${platformRoot}".`,
      );
    }
    return installed;
  }

  const anchorUrls = [join(platformRoot, 'package.json'), ...(options.anchors ?? [])].map(toFileUrl);
  const reported = new Set<string>();

  const handle = registerHooks({
    resolve(specifier, context, nextResolve) {
      const pkg = platformPackageOf(specifier);
      const requesterPath = context.parentURL === undefined ? undefined : urlToPath(context.parentURL);
      if (pkg === undefined || requesterPath === undefined || isInside(platformRoot, requesterPath)) {
        return nextResolve(specifier, context);
      }

      // Own copy first: passing a context to `nextResolve` merges it into the hook's
      // shared context, so resolving from an anchor first would leave the plugin's
      // own lookup pointing at the anchor.
      let ownError: unknown;
      let ownCopy: ReturnType<typeof nextResolve> | undefined;
      try {
        ownCopy = nextResolve(specifier, context);
      } catch (error) {
        ownError = error;
      }

      let hostCopy: ReturnType<typeof nextResolve> | undefined;
      for (const anchor of anchorUrls) {
        try {
          hostCopy = resolveFrom(anchor, specifier, context, nextResolve);
          break;
        } catch {
          // The host does not provide it from this anchor; try the next one.
        }
      }

      if (hostCopy === undefined) {
        if (ownCopy === undefined) {
          throw ownError;
        }
        const ownPath = urlToPath(ownCopy.url);
        if (ownPath === undefined || isInside(platformRoot, ownPath)) {
          return ownCopy;
        }
        throw new PlatformDuplicateError({
          plugin: packageLabel(requesterPath),
          package: pkg,
          ownCopy: ownPath,
          requester: requesterPath,
        });
      }

      if (ownCopy !== undefined && ownCopy.url !== hostCopy.url) {
        const key = `${requesterPath}\0${pkg}`;
        if (!reported.has(key)) {
          reported.add(key);
          const diagnostic: PlatformOverrideDiagnostic = {
            plugin: packageLabel(requesterPath),
            requester: requesterPath,
            specifier,
            package: pkg,
            ownCopy: ownCopy.url,
            hostCopy: hostCopy.url,
          };
          options.logger?.event('warn', {
            event: 'plugin.platform_duplicate_overridden',
            message: `Plugin ${diagnostic.plugin} has its own copy of ${pkg}; using the host's copy`,
            fields: { code: 'KB_PLUGIN_PLATFORM_DUPLICATE', ...diagnostic },
          });
        }
      }
      return hostCopy;
    },
  });

  installed = {
    platformRoot,
    deregister() {
      handle.deregister();
      installed = undefined;
    },
  };
  return installed;
}
