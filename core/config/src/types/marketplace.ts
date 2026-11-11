/** Runtime source order persisted in platform configuration. */
export interface RegistryMarketplaceSourceConfig {
  kind: 'registry';
  url: string;
  signingPublicKey: string;
  authToken?: string;
}

export interface NpmMarketplaceSourceConfig {
  kind: 'npm';
  url: string;
}

export type MarketplaceSourcesConfig =
  | readonly [RegistryMarketplaceSourceConfig, NpmMarketplaceSourceConfig?]
  | readonly [NpmMarketplaceSourceConfig];

/** Runtime schema for the source shape written by kb-create. */
const RegistryMarketplaceSourceSchema = {
  type: 'object',
  properties: {
    kind: { const: 'registry' },
    url: { type: 'string', format: 'uri' },
    signingPublicKey: { type: 'string', minLength: 1 },
    authToken: { type: 'string', minLength: 1 },
  },
  required: ['kind', 'url', 'signingPublicKey'],
  additionalProperties: false,
} as const;

const NpmMarketplaceSourceSchema = {
  type: 'object',
  properties: {
    kind: { const: 'npm' },
    url: { type: 'string', format: 'uri' },
  },
  required: ['kind', 'url'],
  additionalProperties: false,
} as const;

export const MarketplaceConfigSchema = {
  type: 'object',
  properties: {
    sources: {
      oneOf: [
        {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: [RegistryMarketplaceSourceSchema, NpmMarketplaceSourceSchema],
          additionalItems: false,
        },
        {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: [NpmMarketplaceSourceSchema],
          additionalItems: false,
        },
      ],
    },
  },
  required: ['sources'],
  additionalProperties: true,
} as const;
