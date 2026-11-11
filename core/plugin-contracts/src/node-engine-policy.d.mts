/**
 * @param {unknown} value
 * @param {string} [owner]
 * @returns {{ requiredMajor: number }}
 */
export function parseNodeEnginePolicy(value: unknown, owner?: string): {
    requiredMajor: number;
};
/**
 * @param {string} packageManifest
 * @returns {string | undefined}
 */
export function readNodeEngineDeclaration(packageManifest: string): string | undefined;
