/**
 * Resolve whether color is enabled using the ordered rules in colorPolicy.
 * @param {boolean | undefined} isTTY
 * @param {string | undefined} noColor
 * @param {string | undefined} forceColor
 * @param {string | undefined} term
 */
export function resolveColorSupport(isTTY: boolean | undefined, noColor: string | undefined, forceColor: string | undefined, term: string | undefined): boolean;
export namespace colorPolicy {
    namespace forceColorInteger {
        let digits: string[];
        let minimum: number;
    }
    let rules: {
        when: string;
        result: boolean;
    }[];
    let cases: ({
        name: string;
        tty: boolean;
        noColor: string;
        forceColor: undefined;
        term: string;
        want: boolean;
    } | {
        name: string;
        tty: boolean;
        noColor: string;
        forceColor: string;
        term: string;
        want: boolean;
    })[];
}
