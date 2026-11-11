/**
 * Standard ESLint configuration template
 *
 * This is the canonical template for all @kb-labs packages.
 * DO NOT modify this file locally - it is synced from @kb-labs/devkit
 *
 * Customization guidelines:
 * - DevKit preset already includes all standard ignores
 * - Only add project-specific ignores if absolutely necessary
 * - Document why custom ignores are needed
 *
 * @see https://github.com/kb-labs/devkit#eslint-configuration
 */
import nodePreset from '@kb-labs/devkit/eslint/node.js';

export default [
  ...nodePreset,

  // OPTIONAL: Add project-specific ignores only if needed
  // DevKit preset already ignores: dist/, coverage/, node_modules/, *.d.ts, scripts/, etc.
  // {
  //   ignores: [
  //     // Add ONLY project-specific patterns here
  //     // Example: '**/*.generated.ts',
  //   ]
  // }
];
