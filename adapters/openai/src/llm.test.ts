import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { AdapterCredentialsMissingError } from '@kb-labs/sdk';
import { OpenAILLM, type OpenAILLMConfig } from './llm.js';
import { OpenAIEmbeddings } from './embeddings.js';

describe('OpenAILLM credentials', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('exports the adapter manifest from the configured llm subpath', async () => {
    const llm = await import('./llm.js');

    expect(llm.manifest).toMatchObject({ id: 'openai-llm', implements: ['ILLM', 'IEmbeddings'] });
  });

  // case: S-054.8
  it('fails before sending a completion request when no API key is configured', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const adapter = new OpenAILLM();

    await expect(adapter.complete('secret prompt')).rejects.toBeInstanceOf(AdapterCredentialsMissingError);
  });

  // case: S-054.8
  it('fails before opening a stream when no API key is configured', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const adapter = new OpenAILLM();
    const stream = adapter.stream('secret prompt')[Symbol.asyncIterator]();

    await expect(stream.next()).rejects.toBeInstanceOf(AdapterCredentialsMissingError);
  });

  // case: S-054.8
  it('accepts a configured API key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const adapter = new OpenAILLM();
    expect(adapter.getProtocolCapabilities().stream.supported).toBe(true);
  });

  // case: S-054.1
  it('uses the manifest model as the constructor default', async () => {
    const { manifest } = await import('./manifest.js');
    const adapter = new OpenAILLM({ apiKey: 'test-key' });

    expect(Reflect.get(adapter, 'model')).toBe(manifest.configSchema?.model?.default);
    expectTypeOf<OpenAILLMConfig>().toHaveProperty('model');
    expectTypeOf<'defaultModel' extends keyof OpenAILLMConfig ? true : false>().toEqualTypeOf<false>();
  });
});

describe('OpenAIEmbeddings credentials', () => {
  afterEach(() => vi.unstubAllEnvs());

  // case: S-054.24
  it('constructs without credentials and fails with a typed error on the first request', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const adapter = new OpenAIEmbeddings();

    await expect(adapter.embed('hello')).rejects.toMatchObject({
      code: 'KB_ADAPTER_CREDENTIALS_MISSING',
      details: {
        service: 'embeddings',
        credential: 'OPENAI_API_KEY',
        path: 'platform.adapterOptions.embeddings.apiKey',
      },
    });
  });

  // case: S-054.24
  it('declares the embeddings catalogue default and optional key diagnostics', async () => {
    const { manifest } = await import('./manifest.js');
    const { manifest: embeddingsManifest } = await import('./embeddings-manifest.js');

    expect(manifest.defaultFor).toEqual({ llm: ['llm'], embeddings: ['embeddings'] });
    expect(embeddingsManifest.configSchema?.apiKey).toMatchObject({
      required: true,
      secret: true,
      env: 'OPENAI_API_KEY',
    });
    expect(manifest.configSchema?.apiKey?.doctor?.map(({ slot }) => slot)).toEqual(['llm', 'embeddings']);
  });
});
