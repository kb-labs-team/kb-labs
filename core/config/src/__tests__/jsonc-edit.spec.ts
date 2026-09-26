import { describe, it, expect } from 'vitest';

import {
  JsoncPathError,
  JsoncSyntaxError,
  getJsoncValue,
  parseJsonc,
  setJsoncValue,
} from '../user-config/jsonc-edit.js';

const DOC = `{
  // platform section
  "platform": {
    "adapters": {
      "llm": "@kb-labs/adapters-openai", // primary model
      "cache": null /* disabled for now */
    },
    "execution": { "mode": "worker-pool" }
  },

  /* product sections */
  "plugins": { "commit": {} },
}
`;

describe('parseJsonc', () => {
  it('parses comments and trailing commas', () => {
    expect(parseJsonc(DOC)).toEqual({
      platform: {
        adapters: { llm: '@kb-labs/adapters-openai', cache: null },
        execution: { mode: 'worker-pool' },
      },
      plugins: { commit: {} },
    });
  });

  it('reports syntax errors with a position', () => {
    expect(() => parseJsonc('{\n  "a": }')).toThrow(JsoncSyntaxError);
    expect(() => parseJsonc('{ "a": 1 } x')).toThrow(/Unexpected content/);
    expect(() => parseJsonc('{ "a": "unterminated }')).toThrow(/Unterminated string/);
  });
});

describe('setJsoncValue', () => {
  it('replaces an existing value and keeps every comment and the layout byte-for-byte', () => {
    const next = setJsoncValue(DOC, ['platform', 'adapters', 'llm'], '@kb-labs/adapters-vibeproxy');
    expect(next).toBe(DOC.replace('"@kb-labs/adapters-openai"', '"@kb-labs/adapters-vibeproxy"'));
    expect(next).toContain('// primary model');
    expect(next).toContain('/* disabled for now */');
    expect(next).toContain('// platform section');
  });

  it('replaces a value that has a trailing comment', () => {
    const next = setJsoncValue(DOC, ['platform', 'adapters', 'cache'], '@kb-labs/adapters-redis');
    expect(next).toContain('"cache": "@kb-labs/adapters-redis" /* disabled for now */');
  });

  it('appends a new key to a multi-line object, after the trailing comment of the last key (comma stays next to its value)', () => {
    const next = setJsoncValue(DOC, ['platform', 'adapters', 'embeddings'], '@kb-labs/adapters-openai/embeddings');
    expect(next).toContain(
      '      "cache": null, /* disabled for now */\n      "embeddings": "@kb-labs/adapters-openai/embeddings"\n    },',
    );
    expect(parseJsonc(next)).toMatchObject({
      platform: { adapters: { embeddings: '@kb-labs/adapters-openai/embeddings' } },
    });
  });

  it('keeps trailing-comma style when the object already uses it', () => {
    const next = setJsoncValue(DOC, ['qa'], { ok: true });
    expect(next).toContain('  "plugins": { "commit": {} },\n  "qa": {\n    "ok": true\n  },\n}');
    expect(parseJsonc(next)).toMatchObject({ qa: { ok: true } });
  });

  it('creates missing intermediate objects', () => {
    const next = setJsoncValue(DOC, ['platform', 'adapterOptions', 'llm', 'defaultModel'], 'gpt-4o');
    expect(parseJsonc(next)).toMatchObject({
      platform: { adapterOptions: { llm: { defaultModel: 'gpt-4o' } } },
    });
    expect(next).toContain('"adapterOptions": {\n      "llm": {\n        "defaultModel": "gpt-4o"\n      }\n    }');
  });

  it('fills an empty object without losing the comment inside', () => {
    const next = setJsoncValue('{\n  "a": { /* keep me */ }\n}\n', ['a', 'b'], 1);
    expect(next).toContain('/* keep me */');
    expect(parseJsonc(next)).toEqual({ a: { b: 1 } });
  });

  it('expands an empty single-line object onto its own lines', () => {
    const next = setJsoncValue('{\n  "plugins": { "commit": {} }\n}\n', ['plugins', 'commit', 'enabled'], true);
    expect(parseJsonc(next)).toEqual({ plugins: { commit: { enabled: true } } });
    // Inline containers indent relative to the line they start on.
    expect(next).toContain('"plugins": { "commit": {\n    "enabled": true\n  } }');
  });

  it('creates a document from empty text', () => {
    const next = setJsoncValue('', ['platform', 'adapters', 'llm'], '@kb-labs/adapters-openai');
    expect(parseJsonc(next)).toEqual({ platform: { adapters: { llm: '@kb-labs/adapters-openai' } } });
    expect(next.endsWith('\n')).toBe(true);
  });

  it('follows the indentation unit of the document', () => {
    const tabbed = '{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n';
    const next = setJsoncValue(tabbed, ['a', 'c'], { d: 2 });
    expect(next).toBe('{\n\t"a": {\n\t\t"b": 1,\n\t\t"c": {\n\t\t\t"d": 2\n\t\t}\n\t}\n}\n');
  });

  it('sets and appends array elements by index', () => {
    const doc = '{\n  "list": ["a", "b"]\n}\n';
    expect(parseJsonc(setJsoncValue(doc, ['list', '1'], 'z'))).toEqual({ list: ['a', 'z'] });
    expect(getJsoncValue(setJsoncValue(doc, ['list', '2'], 'c'), ['list'])).toEqual(['a', 'b', 'c']);
    expect(() => setJsoncValue(doc, ['list', '5'], 'x')).toThrow(JsoncPathError);
    expect(() => setJsoncValue(doc, ['list', 'name'], 'x')).toThrow(/not an index/);
  });

  it('refuses to descend through a scalar and names where it stopped', () => {
    try {
      setJsoncValue(DOC, ['platform', 'adapters', 'llm', 'model'], 'x');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JsoncPathError);
      expect((error as JsoncPathError).blockedAt).toEqual(['platform', 'adapters', 'llm']);
    }
  });

  it('does not treat keys such as __proto__ specially', () => {
    const next = setJsoncValue('{}', ['__proto__', 'x'], 1);
    expect(Object.prototype.hasOwnProperty.call(parseJsonc(next), '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('is idempotent when the same value is set again', () => {
    const once = setJsoncValue(DOC, ['platform', 'adapters', 'llm'], '@kb-labs/adapters-openai');
    expect(once).toBe(DOC);
  });
});

describe('getJsoncValue', () => {
  it('reads nested values and returns undefined for missing paths', () => {
    expect(getJsoncValue(DOC, ['platform', 'execution', 'mode'])).toBe('worker-pool');
    expect(getJsoncValue(DOC, ['platform', 'nope'])).toBeUndefined();
    expect(getJsoncValue(DOC, ['platform', 'adapters', 'llm', 'x'])).toBeUndefined();
  });
});
