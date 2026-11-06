/**
 * The platform package set (ADR-0048 D5), shared by the plugin resolver and
 * development-time package checks. A plugin's own packages (`@kb-labs/commit/core`, ...)
 * are not platform packages.
 */
const PLATFORM_PACKAGE =
  /^@kb-labs\/(?:sdk|platform-client|plugin-(?:contracts|runtime|execution|execution-factory)|(?:core|cli|shared|adapters)-[a-z0-9-]+)$/;

/** Returns the package name of a bare scoped specifier, or undefined for anything else. */
export function packageNameOf(specifier) {
  if (!specifier.startsWith('@')) {
    return undefined;
  }
  const [scope, name] = specifier.split('/');
  return scope && name ? `${scope}/${name}` : undefined;
}

export function isPlatformPackage(name) {
  return PLATFORM_PACKAGE.test(name);
}

/** The platform package a specifier (`@kb-labs/sdk`, `@kb-labs/sdk/testing`) refers to, if any. */
export function platformPackageOf(specifier) {
  const name = packageNameOf(specifier);
  return name !== undefined && isPlatformPackage(name) ? name : undefined;
}
