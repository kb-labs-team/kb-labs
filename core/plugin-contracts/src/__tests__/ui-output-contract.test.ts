import { describe, expect, it } from 'vitest';
import { renderUIOutputText } from '../ui.js';
import { uiOutputContractCases } from '../ui-output-contract.js';

describe('shared UI output model', () => {
  for (const [kind, contract] of Object.entries(uiOutputContractCases)) {
    it(`renders every ${kind} contract field as readable text`, () => {
      const text = renderUIOutputText(contract.output);
      for (const expected of contract.visibleText) {expect(text).toContain(expected);}
    });
  }
});
