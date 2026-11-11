/**
 * @param {number | string} requiredMajor
 * @param {string} actualVersion
 * @returns {boolean}
 */
export function nodeVersionSupported(requiredMajor: number | string, actualVersion: string): boolean;
/**
 * @param {string} packageManifest
 * @returns {{ requiredMajor: number }}
 */
export function readNodeEnginePolicy(packageManifest: string): {
    requiredMajor: number;
};
/**
 * @param {string | URL} moduleURL
 * @returns {string}
 */
export function runtimePackageManifest(moduleURL: string | URL): string;
/**
 * @param {string} rootManifest
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {string}
 */
export function selectNodeExecutable(rootManifest: string, environment?: NodeJS.ProcessEnv): string;
