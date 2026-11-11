import { resolveColorSupport } from '@kb-labs/plugin-contracts/color-policy';

/**
 * Minimalist color utilities for CLI output
 * Uses strategic color application - only for status, not decoration
 */

const CSI = '\x1b[';
const RESET = '\x1b[0m';

// Every exported color helper follows the shared host/CLI terminal policy.
export const supportsColor = (() => {
  if (typeof process === 'undefined') {return false;}
  return resolveColorSupport(process.stdout?.isTTY, process.env.NO_COLOR, process.env.FORCE_COLOR, process.env.TERM);
})();

const createColor =
  (...codes: Array<number | string>) =>
  (text: string): string =>
    supportsColor ? `${CSI}${codes.join(';')}m${text}${RESET}` : text;

const accentBlue = '38;5;39';
const accentViolet = '38;5;99';
const accentTeal = '38;5;51';
const accentIndigo = '38;5;63';
const neutral = 37;
const neutralMuted = 90;

export const colors = {
  // Semantic colors
  success: createColor(32),
  error: createColor(31),
  warning: createColor(33),
  info: createColor(36),

  // Accent palette (reused across CLI)
  primary: createColor(accentBlue),
  accent: createColor(accentViolet),
  highlight: createColor(accentTeal),
  secondary: createColor(accentIndigo),
  emphasis: createColor('38;5;117'),
  muted: createColor(neutralMuted),
  foreground: createColor(neutral),

  // Formatting helpers
  dim: createColor(2),
  bold: createColor(1),
  underline: createColor(4),
  inverse: createColor(7),
};

// Unicode symbols — KB Labs visual identity
const symbolCharacters = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: '◆',
  bullet: '•',
  clock: '◷',
  folder: '▸',
  package: '◆',
  pointer: '❯',
  section: '│',
  step: '○',
  stepDone: '●',
  arrow: '→',
  diamond: '◆',
};

export const symbols = {
  success: colors.success(symbolCharacters.success),
  error: colors.error(symbolCharacters.error),
  warning: colors.warning(symbolCharacters.warning),
  info: colors.info(symbolCharacters.info),
  bullet: colors.muted(symbolCharacters.bullet),
  clock: colors.muted(symbolCharacters.clock),
  folder: colors.primary(symbolCharacters.folder),
  package: colors.accent(symbolCharacters.package),
  pointer: colors.primary(symbolCharacters.pointer),
  section: colors.muted(symbolCharacters.section),
  step: colors.muted(symbolCharacters.step),
  stepDone: colors.success(symbolCharacters.stepDone),
  arrow: colors.primary(symbolCharacters.arrow),
  diamond: colors.primary(symbolCharacters.diamond),
};

// Compatibility-safe wrappers remain for callers that opt into safe output.
const passthrough =
  (fn: (text: string) => string) =>
  (text: string): string =>
    supportsColor ? fn(text) : text;

export const safeColors = {
  success: passthrough(colors.success),
  error: passthrough(colors.error),
  warning: passthrough(colors.warning),
  info: passthrough(colors.info),
  accent: passthrough(colors.accent),
  primary: passthrough(colors.primary),
  highlight: passthrough(colors.highlight),
  secondary: passthrough(colors.secondary),
  emphasis: passthrough(colors.emphasis),
  foreground: passthrough(colors.foreground),
  muted: passthrough(colors.muted),
  dim: passthrough(colors.dim),
  bold: passthrough(colors.bold),
  underline: passthrough(colors.underline),
  inverse: passthrough(colors.inverse),
};

export const safeSymbols = {
  success: supportsColor ? symbols.success : '✓',
  error: supportsColor ? symbols.error : '✗',
  warning: supportsColor ? symbols.warning : '⚠',
  info: supportsColor ? symbols.info : '◆',
  bullet: supportsColor ? symbols.bullet : '•',
  clock: supportsColor ? symbols.clock : '◷',
  folder: supportsColor ? symbols.folder : '▸',
  package: supportsColor ? symbols.package : '◆',
  pointer: supportsColor ? symbols.pointer : '❯',
  section: supportsColor ? symbols.section : '│',
  step: supportsColor ? symbols.step : '○',
  stepDone: supportsColor ? symbols.stepDone : '●',
  arrow: supportsColor ? symbols.arrow : '→',
  diamond: supportsColor ? symbols.diamond : '◆',
  // Box-drawing characters
  separator: '─',
  border: '│',
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  leftT: '├',
  rightT: '┤',
};
