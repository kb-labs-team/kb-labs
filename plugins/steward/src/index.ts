// Re-export the manifest as a side-channel for tooling that imports the
// package directly (e.g. marketplace registration tooling). The primary entry point
// is the "kb.manifest" field in package.json pointing at ./dist/manifest.js.
export { manifest } from './manifest.js';
