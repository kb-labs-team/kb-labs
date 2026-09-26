// Core exports
export * from './types/index.js';
export * from './runtime/index.js';
export * from './utils/index.js';
export * from './utils/paths.js';

// Enhanced config system exports
export * from './errors/kb-error.js';
export * from './cache/fs-cache.js';
export * from './hash/config-hash.js';
export * from './api/read-config.js';
export * from './api/read-kb-config.js';
export * from './merge/layered-merge.js';
export * from './api/product-config.js';
export * from './preset/resolve-preset.js';
export * from './lockfile/lockfile.js';
export * from './types/preset.js';
export * from './profiles/types.js';
export * from './profiles/loader.js';
export * from './profiles/scope-selector.js';
export * from './profiles/resolver.js';

// Init system exports
export * from './types/init.js';
export * from './api/init-workspace.js';
export * from './api/upsert-lockfile.js';
export * from './utils/fs-atomic.js';

// Re-export clearCaches for convenience
export { clearCaches } from './cache/fs-cache.js';

// Validation API
export { validateProductConfig, registerProductSchema } from './validation/validate-config.js';

// Overlay primitives (`mergeOverlay`, `loadOverlays`) used by the layered
// loader below and by services that need raw access.
export * from './overlay/index.js';

// Config layers (generated vs user, provenance) and the one user-config writer (ADR-0047).
export * from './user-config/index.js';

// Canonical layered config loader: generated → platform → project → project overlays.
// Use this when reading the raw effective config (e.g. plugin sections).
export * from './api/effective-config.js';
