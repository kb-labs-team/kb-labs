/**
 * Host CLI color policy shared with generated Go and POSIX shell consumers.
 * Keep the precedence and behavioral cases here; generated consumers are
 * checked by tools/clikit/ui/generate-color-policy.mjs --check.
 *
 * NO_COLOR: https://no-color.org/
 * FORCE_COLOR: https://github.com/chalk/supports-color
 */
export const colorPolicy = {
  forceColorInteger: { digits: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], minimum: 1 },
  rules: [
    { when: 'noColorNonEmpty', result: false },
    { when: 'forceColorDisabled', result: false },
    { when: 'forceColorEnabled', result: true },
    { when: 'termDumb', result: false },
    { when: 'tty', result: true },
  ],
  cases: [
    { name: 'piped default', tty: false, noColor: '', forceColor: undefined, term: 'xterm-256color', want: false },
    { name: 'terminal default', tty: true, noColor: '', forceColor: undefined, term: 'xterm-256color', want: true },
    { name: 'empty NO_COLOR terminal', tty: true, noColor: '', forceColor: undefined, term: 'xterm-256color', want: true },
    { name: 'forced color pipe', tty: false, noColor: '', forceColor: '1', term: 'dumb', want: true },
    { name: 'TERM dumb terminal', tty: true, noColor: '', forceColor: undefined, term: 'dumb', want: false },
    { name: 'NO_COLOR beats force', tty: true, noColor: '1', forceColor: '1', term: 'xterm-256color', want: false },
    { name: 'FORCE_COLOR zero', tty: true, noColor: '', forceColor: '0', term: 'xterm-256color', want: false },
    { name: 'FORCE_COLOR false', tty: true, noColor: '', forceColor: 'false', term: 'xterm-256color', want: false },
    { name: 'FORCE_COLOR empty', tty: false, noColor: '', forceColor: '', term: 'dumb', want: true },
    { name: 'FORCE_COLOR true', tty: false, noColor: '', forceColor: 'true', term: 'dumb', want: true },
    { name: 'FORCE_COLOR numeric level', tty: false, noColor: '', forceColor: '2', term: 'dumb', want: true },
    { name: 'FORCE_COLOR decimal ignored by dumb TERM', tty: false, noColor: '', forceColor: '1.5', term: 'dumb', want: false },
    { name: 'FORCE_COLOR signed positive ignored in pipe', tty: false, noColor: '', forceColor: '+1', term: 'xterm-256color', want: false },
    { name: 'FORCE_COLOR signed negative falls through to TTY', tty: true, noColor: '', forceColor: '-1', term: 'xterm-256color', want: true },
    { name: 'FORCE_COLOR leading zero integer enables', tty: false, noColor: '', forceColor: '01', term: 'dumb', want: true },
    { name: 'FORCE_COLOR whitespace ignored in pipe', tty: false, noColor: '', forceColor: ' 1', term: 'xterm-256color', want: false },
    { name: 'FORCE_COLOR below one falls through', tty: false, noColor: '', forceColor: '0.5', term: 'xterm-256color', want: false },
    { name: 'FORCE_COLOR invalid pipe falls through', tty: false, noColor: '', forceColor: 'garbage', term: 'xterm-256color', want: false },
    { name: 'FORCE_COLOR invalid terminal falls through', tty: true, noColor: '', forceColor: 'garbage', term: 'dumb', want: false },
    { name: 'NO_COLOR beats empty FORCE_COLOR', tty: false, noColor: '1', forceColor: '', term: 'xterm-256color', want: false },
  ],
};

/**
 * Resolve whether color is enabled using the ordered rules in colorPolicy.
 * @param {boolean | undefined} isTTY
 * @param {string | undefined} noColor
 * @param {string | undefined} forceColor
 * @param {string | undefined} term
 */
export function resolveColorSupport(isTTY, noColor, forceColor, term) {
  for (const rule of colorPolicy.rules) {
    const matches = rule.when === 'noColorNonEmpty' ? Boolean(noColor)
      : rule.when === 'forceColorDisabled' ? forceColor === 'false' || forceColor === '0'
        : rule.when === 'forceColorEnabled' ? forceColor !== undefined && forceColorEnables(forceColor)
          : rule.when === 'termDumb' ? term?.toLowerCase() === 'dumb'
            : rule.when === 'tty' ? isTTY === true
              : false;
    if (matches) return rule.result;
  }
  return false;
}

const forceColorIntegerPattern = new RegExp(`^[${colorPolicy.forceColorInteger.digits.join('')}]+$`);

/** @param {string} value */
function forceColorEnables(value) {
  if (value === '' || value === 'true') return true;
  return forceColorIntegerPattern.test(value) && Number(value) >= colorPolicy.forceColorInteger.minimum;
}
