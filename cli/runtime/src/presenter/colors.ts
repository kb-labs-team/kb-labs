import { createColors } from "colorette";
import { resolveColorSupport } from '@kb-labs/plugin-contracts/color-policy';

const colorsWithPolicy = createColors({
  useColor: resolveColorSupport(process.stdout?.isTTY, process.env.NO_COLOR, process.env.FORCE_COLOR, process.env.TERM),
});
const { bold, dim, gray, green, red, yellow, cyan, blue } = colorsWithPolicy;

/**
 * Color utilities for CLI output using the shared host color policy.
 */
export const colors = {
  bold,
  dim,
  gray,
  green,
  red,
  yellow,
  cyan,
  blue,
} as const;

// Export individual functions for convenience
export { bold, dim, gray, green, red, yellow, cyan, blue };
