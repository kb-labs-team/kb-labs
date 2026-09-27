import { describe, expect, it } from 'vitest';
import {
  LLM_CONTRACT,
  LLMContentValidationError,
  getLLMContentText,
  validateLLMContent,
} from './llm-types.js';

describe('LLM contract registry', () => {
  it('keeps content-part capability references inside the canonical capability catalog', () => {
    const capabilityIds = new Set(Object.keys(LLM_CONTRACT.capabilities));

    for (const part of Object.values(LLM_CONTRACT.contentParts)) {
      for (const capability of part.requiredCapabilities) {
        expect(capabilityIds.has(capability)).toBe(true);
      }
    }
  });

  it('keeps text as the implicit baseline without optional capability requirements', () => {
    expect(validateLLMContent('user', 'plain text')).toEqual({
      content: 'plain text',
      requiredCapabilities: [],
    });
    expect(validateLLMContent('user', [{ type: 'text', text: 'plain text' }])).toEqual({
      content: [{ type: 'text', text: 'plain text' }],
      requiredCapabilities: [],
    });
  });

  it('validates image shape and derives vision from the same registry entry', () => {
    const content = [
      { type: 'text', text: 'What is shown?' },
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
    ];

    expect(validateLLMContent('user', content)).toEqual({
      content,
      requiredCapabilities: ['vision'],
    });
  });

  it('rejects invalid image data, unknown parts, and image parts in non-user messages', () => {
    expect(() => validateLLMContent('user', [
      { type: 'image', mediaType: 'image/png', data: 'not base64!' },
    ])).toThrow(LLMContentValidationError);

    expect(() => validateLLMContent('user', [{ type: 'audio', data: 'aGVsbG8=' }]))
      .toThrow(/does not match any registered content schema/);

    expect(() => validateLLMContent('assistant', [
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
    ])).toThrow(/not allowed for role/);
  });

  it('projects mixed content to text without exposing image payloads', () => {
    expect(getLLMContentText([
      { type: 'text', text: 'Describe this' },
      { type: 'image', mediaType: 'image/png', data: 'secret-base64-payload' },
    ])).toBe('Describe this\n[image input]');
    expect(getLLMContentText('plain text')).toBe('plain text');
  });
});
