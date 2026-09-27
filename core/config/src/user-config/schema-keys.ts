/**
 * @module @kb-labs/core-config/user-config/schema-keys
 *
 * Key-path resolution against a zod schema, used by `config set` to reject
 * typos with a "did you mean" suggestion instead of silently writing an inert
 * key.
 *
 * Rules:
 *   - a `.strict()` object is closed: any key outside its shape is unknown;
 *   - any other object (default, `.passthrough()`, `.catchall()`) and any
 *     record is open, so product sections and custom adapter slots keep
 *     working, EXCEPT that a key that is a near-miss of a declared key
 *     (edit distance <= 2, and never equal) is reported as a probable typo;
 *   - unions are searched for the first option that can hold the next key.
 */

import { z, type ZodTypeAny } from 'zod';

export type KeyResolution =
  | {
      status: 'ok';
      /** Schema of the addressed value, or `undefined` when the path enters an open, unschematised area. */
      schema: ZodTypeAny | undefined;
    }
  | {
      status: 'unknown';
      /** Dotted path of the container that does not have the key. */
      parentPath: string;
      /** The offending key. */
      key: string;
      /** Closest declared key, if any is near. */
      suggestion?: string;
      /** All keys the container declares. */
      knownKeys: string[];
    };

/** Levenshtein distance, capped for speed (returns cap + 1 beyond it). */
export function editDistance(a: string, b: string, cap = 3): number {
  if (a === b) {
    return 0;
  }
  if (Math.abs(a.length - b.length) > cap) {
    return cap + 1;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > cap) {
      return cap + 1;
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/** The candidate closest to `key` within `maxDistance`, case-insensitively; undefined when none is near. */
export function suggestKey(key: string, candidates: readonly string[], maxDistance = 2): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    if (candidate === key) {
      continue;
    }
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase(), maxDistance);
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
}

/** Strip optional / nullable / default / brand / effects / lazy wrappers. */
export function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  for (let guard = 0; guard < 16; guard++) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodReadonly
    ) {
      current = current.unwrap() as ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as ZodTypeAny;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType() as ZodTypeAny;
    } else if (current instanceof z.ZodBranded) {
      current = current.unwrap() as ZodTypeAny;
    } else if (current instanceof z.ZodLazy) {
      current = current.schema as ZodTypeAny;
    } else {
      return current;
    }
  }
  return current;
}

function isClosedObject(schema: z.ZodObject<z.ZodRawShape>): boolean {
  return schema._def.unknownKeys === 'strict';
}

/** Candidates for descending into `segment` from `schema` (unions fan out). */
function containerOptions(schema: ZodTypeAny): ZodTypeAny[] {
  const inner = unwrapSchema(schema);
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) {
    const options = inner.options as ZodTypeAny[];
    return options.flatMap((option) => containerOptions(option));
  }
  return [inner];
}

/** Keys declared directly on an object schema (union-aware). */
export function declaredKeys(schema: ZodTypeAny | undefined): string[] {
  if (!schema) {
    return [];
  }
  const keys = new Set<string>();
  for (const option of containerOptions(schema)) {
    if (option instanceof z.ZodObject) {
      for (const key of Object.keys(option.shape as Record<string, unknown>)) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

/**
 * Resolve `path` against `schema`. Returns the schema of the addressed value,
 * or an `unknown` result naming the first segment that the schema rejects.
 */
export function resolveKeyPath(schema: ZodTypeAny, path: readonly string[]): KeyResolution {
  let current: ZodTypeAny | undefined = schema;

  for (let depth = 0; depth < path.length; depth++) {
    const segment = path[depth]!;
    if (!current) {
      // Inside an open, unschematised area: nothing to check.
      return { status: 'ok', schema: undefined };
    }

    const options = containerOptions(current);
    let next: ZodTypeAny | undefined;
    let matched = false;
    const known = new Set<string>();

    for (const option of options) {
      if (option instanceof z.ZodObject) {
        const shape = option.shape as Record<string, ZodTypeAny>;
        for (const key of Object.keys(shape)) {
          known.add(key);
        }
        if (Object.prototype.hasOwnProperty.call(shape, segment)) {
          next = shape[segment];
          matched = true;
          break;
        }
        const catchall = option._def.catchall as ZodTypeAny;
        if (!(catchall instanceof z.ZodNever)) {
          next = catchall;
          matched = true;
        } else if (!isClosedObject(option)) {
          matched = true;
          next = undefined;
        }
      } else if (option instanceof z.ZodRecord) {
        next = option.valueSchema as ZodTypeAny;
        matched = true;
      } else if (option instanceof z.ZodArray) {
        if (/^\d+$/.test(segment)) {
          next = option.element as ZodTypeAny;
          matched = true;
          break;
        }
      } else if (option instanceof z.ZodAny || option instanceof z.ZodUnknown) {
        matched = true;
        next = undefined;
      }
    }

    if (!matched) {
      // Scalar or closed container with no such key.
      const knownKeys = [...known];
      return {
        status: 'unknown',
        parentPath: path.slice(0, depth).join('.'),
        key: segment,
        suggestion: suggestKey(segment, knownKeys),
        knownKeys,
      };
    }

    // Open container: a near-miss of a declared key is still a probable typo.
    if (known.size > 0 && !known.has(segment)) {
      const near = suggestKey(segment, [...known]);
      if (near) {
        return {
          status: 'unknown',
          parentPath: path.slice(0, depth).join('.'),
          key: segment,
          suggestion: near,
          knownKeys: [...known],
        };
      }
    }

    current = next;
  }

  return { status: 'ok', schema: current };
}

export interface FlatIssue {
  /** Dotted path of the offending value (empty for the document root). */
  path: string;
  message: string;
}

/**
 * Flatten zod issues to `{ path, message }`. A failed union is replaced by the
 * issues of the branch the value most plausibly meant (the branch that
 * accepted the value's type and failed deeper), so the reported path names the
 * offending field instead of the union as a whole.
 */
export function flattenZodIssues(error: z.ZodError): FlatIssue[] {
  const out: FlatIssue[] = [];
  const visit = (issues: readonly z.ZodIssue[]): void => {
    for (const issue of issues) {
      if (issue.code === 'invalid_union') {
        const deeper = issue.unionErrors
          .map((branch) => branch.issues)
          .find((branchIssues) => branchIssues.every((i) => i.path.length > issue.path.length));
        if (deeper) {
          visit(deeper);
          continue;
        }
      }
      out.push({ path: issue.path.join('.'), message: issue.message });
    }
  };
  visit(error.issues);
  return out;
}
