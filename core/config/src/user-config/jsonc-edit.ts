/**
 * @module @kb-labs/core-config/user-config/jsonc-edit
 *
 * Minimal comment-preserving JSONC editor.
 *
 * The repository has no JSONC library that can rewrite a document without
 * losing comments (the loader only *strips* comments). Config files are
 * human-reviewed in git, so `kb config set` must change only the bytes of the
 * value it touches. This module parses a JSONC document into a small
 * position-aware tree and applies a single "set value at path" edit as a text
 * splice: everything outside the edited span (comments, blank lines, key
 * order, trailing commas, indentation) is left byte-for-byte intact.
 *
 * Supported syntax: JSON plus `//` and block comments and trailing commas.
 */

export interface JsoncPosition {
  offset: number;
  line: number;
  column: number;
}

export class JsoncSyntaxError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, text: string, offset: number) {
    const pos = positionAt(text, offset);
    super(`${message} at line ${pos.line}, column ${pos.column}`);
    this.name = 'JsoncSyntaxError';
    this.offset = offset;
    this.line = pos.line;
    this.column = pos.column;
  }
}

/** Raised when a path cannot be applied to the document structure. */
export class JsoncPathError extends Error {
  /** Path prefix that could not be traversed. */
  readonly blockedAt: string[];

  constructor(message: string, blockedAt: string[]) {
    super(message);
    this.name = 'JsoncPathError';
    this.blockedAt = blockedAt;
  }
}

interface NodeBase {
  start: number;
  end: number;
}

export interface JsoncProperty {
  key: string;
  keyStart: number;
  value: JsoncNode;
}

export interface JsoncObjectNode extends NodeBase {
  kind: 'object';
  properties: JsoncProperty[];
}

export interface JsoncArrayNode extends NodeBase {
  kind: 'array';
  items: JsoncNode[];
}

export interface JsoncScalarNode extends NodeBase {
  kind: 'scalar';
  value: string | number | boolean | null;
}

export type JsoncNode = JsoncObjectNode | JsoncArrayNode | JsoncScalarNode;

function positionAt(text: string, offset: number): JsoncPosition {
  let line = 1;
  let column = 1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { offset, line, column };
}

class Parser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JsoncNode {
    this.skipTrivia();
    if (this.pos >= this.text.length) {
      throw new JsoncSyntaxError('Unexpected end of input', this.text, this.pos);
    }
    const node = this.parseValue();
    this.skipTrivia();
    if (this.pos < this.text.length) {
      throw new JsoncSyntaxError('Unexpected content after the top-level value', this.text, this.pos);
    }
    return node;
  }

  private skipTrivia(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const ch = t[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '﻿') {
        this.pos++;
      } else if (ch === '/' && t[this.pos + 1] === '/') {
        while (this.pos < t.length && t[this.pos] !== '\n') {
          this.pos++;
        }
      } else if (ch === '/' && t[this.pos + 1] === '*') {
        const close = t.indexOf('*/', this.pos + 2);
        if (close === -1) {
          throw new JsoncSyntaxError('Unterminated block comment', t, this.pos);
        }
        this.pos = close + 2;
      } else {
        break;
      }
    }
  }

  private parseValue(): JsoncNode {
    const ch = this.text[this.pos];
    if (ch === '{') {
      return this.parseObject();
    }
    if (ch === '[') {
      return this.parseArray();
    }
    if (ch === '"') {
      const start = this.pos;
      const value = this.parseString();
      return { kind: 'scalar', start, end: this.pos, value };
    }
    return this.parseLiteral();
  }

  private parseObject(): JsoncObjectNode {
    const start = this.pos;
    this.pos++; // {
    const properties: JsoncProperty[] = [];
    for (;;) {
      this.skipTrivia();
      const ch = this.text[this.pos];
      if (ch === undefined) {
        throw new JsoncSyntaxError('Unterminated object', this.text, start);
      }
      if (ch === '}') {
        this.pos++;
        return { kind: 'object', start, end: this.pos, properties };
      }
      if (ch !== '"') {
        throw new JsoncSyntaxError('Expected a property name', this.text, this.pos);
      }
      const keyStart = this.pos;
      const key = this.parseString();
      this.skipTrivia();
      if (this.text[this.pos] !== ':') {
        throw new JsoncSyntaxError('Expected ":" after the property name', this.text, this.pos);
      }
      this.pos++;
      this.skipTrivia();
      if (this.pos >= this.text.length) {
        throw new JsoncSyntaxError('Unexpected end of input', this.text, this.pos);
      }
      const value = this.parseValue();
      properties.push({ key, keyStart, value });
      this.skipTrivia();
      const next = this.text[this.pos];
      if (next === ',') {
        this.pos++;
      } else if (next !== '}') {
        throw new JsoncSyntaxError('Expected "," or "}"', this.text, this.pos);
      }
    }
  }

  private parseArray(): JsoncArrayNode {
    const start = this.pos;
    this.pos++; // [
    const items: JsoncNode[] = [];
    for (;;) {
      this.skipTrivia();
      const ch = this.text[this.pos];
      if (ch === undefined) {
        throw new JsoncSyntaxError('Unterminated array', this.text, start);
      }
      if (ch === ']') {
        this.pos++;
        return { kind: 'array', start, end: this.pos, items };
      }
      items.push(this.parseValue());
      this.skipTrivia();
      const next = this.text[this.pos];
      if (next === ',') {
        this.pos++;
      } else if (next !== ']') {
        throw new JsoncSyntaxError('Expected "," or "]"', this.text, this.pos);
      }
    }
  }

  private parseString(): string {
    const start = this.pos;
    this.pos++; // opening quote
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '\\') {
        this.pos += 2;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        const raw = this.text.slice(start, this.pos);
        try {
          return JSON.parse(raw) as string;
        } catch {
          throw new JsoncSyntaxError('Invalid string literal', this.text, start);
        }
      }
      if (ch === '\n') {
        break;
      }
      this.pos++;
    }
    throw new JsoncSyntaxError('Unterminated string', this.text, start);
  }

  private parseLiteral(): JsoncScalarNode {
    const start = this.pos;
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      this.text.slice(this.pos, this.pos + 64),
    );
    if (!match) {
      throw new JsoncSyntaxError('Unexpected token', this.text, start);
    }
    this.pos += match[0].length;
    const value = JSON.parse(match[0]) as boolean | number | null;
    return { kind: 'scalar', start, end: this.pos, value };
  }
}

/** Parse a JSONC document into a position-aware tree. Throws `JsoncSyntaxError`. */
export function parseJsoncTree(text: string): JsoncNode {
  return new Parser(text).parseDocument();
}

/** Convert a tree node into a plain JS value. */
export function jsoncNodeToValue(node: JsoncNode): unknown {
  switch (node.kind) {
    case 'scalar':
      return node.value;
    case 'array':
      return node.items.map(jsoncNodeToValue);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties) {
        Object.defineProperty(out, prop.key, {
          value: jsoncNodeToValue(prop.value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
  }
}

/** Parse a JSONC document straight into a plain value. */
export function parseJsonc(text: string): unknown {
  return jsoncNodeToValue(parseJsoncTree(text));
}

// ──────────────────────────────────────────────────────────────────────────
// Editing
// ──────────────────────────────────────────────────────────────────────────

interface TextEdit {
  offset: number;
  length: number;
  insert: string;
}

function applyEdits(text: string, edits: TextEdit[]): string {
  // Apply from the end so earlier offsets stay valid.
  const sorted = [...edits].sort((a, b) => b.offset - a.offset);
  let out = text;
  for (const edit of sorted) {
    out = out.slice(0, edit.offset) + edit.insert + out.slice(edit.offset + edit.length);
  }
  return out;
}

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset));
  return match ? match[0] : '';
}

/** True when only whitespace precedes `offset` on its line. */
function startsLine(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, offset));
}

/** Indent unit of the document: the first indented line wins, default two spaces. */
export function detectIndentUnit(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  return match ? match[1]! : '  ';
}

function formatValue(value: unknown, indent: string, unit: string): string {
  const json = JSON.stringify(value, null, unit);
  // JSON.stringify(undefined) returns undefined; callers never pass it.
  return (json ?? 'null').split('\n').join(`\n${indent}`);
}

function formatKey(key: string): string {
  return JSON.stringify(key);
}

/** Build the text of a nested `{ "a": { "b": value } }` chain for the missing tail of a path. */
function buildNested(rest: string[], value: unknown): unknown {
  let acc: unknown = value;
  for (let i = rest.length - 1; i >= 0; i--) {
    acc = { [rest[i]!]: acc };
  }
  return acc;
}

/**
 * Position just after the separator that follows a value: an optional `,` and
 * an optional trailing same-line comment. New properties are inserted there so
 * that a trailing comment keeps belonging to the property it annotates.
 */
function afterValueTail(text: string, valueEnd: number): { insertAt: number; hadComma: boolean; commaAt: number } {
  let i = valueEnd;
  let hadComma = false;
  let commaAt = valueEnd;
  const skipSpaces = (): void => {
    while (text[i] === ' ' || text[i] === '\t') {
      i++;
    }
  };
  skipSpaces();
  if (text[i] === ',') {
    hadComma = true;
    commaAt = i;
    i++;
  }
  const afterComma = i;
  skipSpaces();
  if (text[i] === '/' && text[i + 1] === '/') {
    while (i < text.length && text[i] !== '\n') {
      i++;
    }
    return { insertAt: i, hadComma, commaAt };
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    const close = text.indexOf('*/', i + 2);
    if (close !== -1 && !text.slice(i, close).includes('\n')) {
      return { insertAt: close + 2, hadComma, commaAt };
    }
  }
  return { insertAt: hadComma ? afterComma : valueEnd, hadComma, commaAt };
}

function insertProperty(
  text: string,
  obj: JsoncObjectNode,
  key: string,
  value: unknown,
  unit: string,
): TextEdit[] {
  const objIndent = lineIndentAt(text, obj.start);
  const last = obj.properties[obj.properties.length - 1];

  if (!last) {
    const childIndent = objIndent + unit;
    const inner = text.slice(obj.start + 1, obj.end - 1);
    const edits: TextEdit[] = [
      {
        offset: obj.start + 1,
        length: 0,
        insert: `\n${childIndent}${formatKey(key)}: ${formatValue(value, childIndent, unit)}`,
      },
    ];
    if (!inner.includes('\n')) {
      // `{}` or `{ }` on one line: move the closing brace to its own line.
      edits[0]!.length = inner.trim() === '' ? inner.length : 0;
      edits.unshift({ offset: obj.end - 1, length: 0, insert: `\n${objIndent}` });
    }
    return edits;
  }

  const first = obj.properties[0]!;
  const childIndent = startsLine(text, first.keyStart) ? lineIndentAt(text, first.keyStart) : objIndent + unit;
  const tail = afterValueTail(text, last.value.end);
  const rendered = `${formatKey(key)}: ${formatValue(value, childIndent, unit)}`;

  if (tail.hadComma) {
    // Trailing-comma style: keep it for the new last property.
    return [{ offset: tail.insertAt, length: 0, insert: `\n${childIndent}${rendered},` }];
  }
  // Same-offset edits apply in array order and each lands before the previous
  // one, so the property goes first and the comma second (comma ends up first).
  return [
    { offset: tail.insertAt, length: 0, insert: `\n${childIndent}${rendered}` },
    { offset: last.value.end, length: 0, insert: ',' },
  ];
}

function insertArrayItem(text: string, arr: JsoncArrayNode, value: unknown, unit: string): TextEdit[] {
  const arrIndent = lineIndentAt(text, arr.start);
  const last = arr.items[arr.items.length - 1];
  if (!last) {
    const childIndent = arrIndent + unit;
    const inner = text.slice(arr.start + 1, arr.end - 1);
    const edits: TextEdit[] = [
      { offset: arr.start + 1, length: 0, insert: `\n${childIndent}${formatValue(value, childIndent, unit)}` },
    ];
    if (!inner.includes('\n')) {
      edits[0]!.length = inner.trim() === '' ? inner.length : 0;
      edits.unshift({ offset: arr.end - 1, length: 0, insert: `\n${arrIndent}` });
    }
    return edits;
  }
  const childIndent = startsLine(text, last.start) ? lineIndentAt(text, last.start) : arrIndent + unit;
  const tail = afterValueTail(text, last.end);
  const rendered = formatValue(value, childIndent, unit);
  if (tail.hadComma) {
    return [{ offset: tail.insertAt, length: 0, insert: `\n${childIndent}${rendered},` }];
  }
  return [
    { offset: tail.insertAt, length: 0, insert: `\n${childIndent}${rendered}` },
    { offset: last.end, length: 0, insert: ',' },
  ];
}

/**
 * Set `value` at `path` (object keys or array indexes as strings) and return
 * the new document text. Missing object segments are created. Comments and
 * formatting outside the edited span are preserved.
 *
 * An empty or whitespace-only `text` is treated as `{}`.
 *
 * Throws `JsoncSyntaxError` for an unparsable document and `JsoncPathError`
 * when the path runs through a non-container value (or past the end of an
 * array).
 */
export function setJsoncValue(text: string, path: readonly string[], value: unknown): string {
  if (path.length === 0) {
    throw new JsoncPathError('Cannot replace the whole document; provide a key path', []);
  }
  const base = text.trim() === '' ? '{}\n' : text;
  const unit = detectIndentUnit(base);
  let node = parseJsoncTree(base);

  for (let depth = 0; depth < path.length; depth++) {
    const segment = path[depth]!;
    const isLast = depth === path.length - 1;
    const walked = path.slice(0, depth + 1);

    if (node.kind === 'object') {
      const prop = node.properties.find((p) => p.key === segment);
      if (!prop) {
        const nested = isLast ? value : buildNested(path.slice(depth + 1), value);
        return applyEdits(base, insertProperty(base, node, segment, nested, unit));
      }
      if (isLast) {
        const indent = startsLine(base, prop.keyStart) ? lineIndentAt(base, prop.keyStart) : lineIndentAt(base, node.start);
        return applyEdits(base, [
          {
            offset: prop.value.start,
            length: prop.value.end - prop.value.start,
            insert: formatValue(value, indent, unit),
          },
        ]);
      }
      node = prop.value;
      continue;
    }

    if (node.kind === 'array') {
      if (!/^\d+$/.test(segment)) {
        throw new JsoncPathError(`"${walked.slice(0, -1).join('.')}" is an array; "${segment}" is not an index`, walked.slice(0, -1));
      }
      const index = Number(segment);
      const item = node.items[index];
      if (!item) {
        if (index === node.items.length && isLast) {
          return applyEdits(base, insertArrayItem(base, node, value, unit));
        }
        throw new JsoncPathError(`Index ${index} is past the end of "${walked.slice(0, -1).join('.')}"`, walked.slice(0, -1));
      }
      if (isLast) {
        const indent = startsLine(base, item.start) ? lineIndentAt(base, item.start) : lineIndentAt(base, node.start);
        return applyEdits(base, [
          { offset: item.start, length: item.end - item.start, insert: formatValue(value, indent, unit) },
        ]);
      }
      node = item;
      continue;
    }

    throw new JsoncPathError(
      `"${walked.slice(0, -1).join('.')}" is a ${describeScalar(node)} value and has no "${segment}" key`,
      walked.slice(0, -1),
    );
  }

  // Unreachable: the loop always returns on the last segment.
  throw new JsoncPathError('Path could not be applied', [...path]);
}

function describeScalar(node: JsoncScalarNode): string {
  if (node.value === null) {
    return 'null';
  }
  return typeof node.value;
}

/** Read the value at `path`, or `undefined` when the path does not exist. */
export function getJsoncValue(text: string, path: readonly string[]): unknown {
  let value: unknown = parseJsonc(text);
  for (const segment of path) {
    if (Array.isArray(value)) {
      value = /^\d+$/.test(segment) ? value[Number(segment)] : undefined;
    } else if (value !== null && typeof value === 'object') {
      value = Object.prototype.hasOwnProperty.call(value, segment)
        ? (value as Record<string, unknown>)[segment]
        : undefined;
    } else {
      return undefined;
    }
  }
  return value;
}
