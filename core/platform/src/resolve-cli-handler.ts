import path from 'node:path';

/** Resolve a ManifestV3 CLI handler to the package's built JavaScript file. */
export function resolveCliHandlerPath(packageRoot: string, handler: string): string {
  const handlerReference = handler.split('#', 1)[0] ?? '';
  return handlerReference.startsWith('dist/')
    ? path.resolve(packageRoot, handlerReference)
    : path.resolve(packageRoot, 'dist', handlerReference.replace(/^\.\//, ''));
}
