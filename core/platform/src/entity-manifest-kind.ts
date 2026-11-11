/** Schema registry shared by manifest consumers that need entity-kind dispatch. */
export const ENTITY_MANIFEST_KINDS = {
  'kb.plugin/3': 'plugin',
  'kb.adapter/1': 'adapter',
  'kb.service/1': 'service',
} as const;

export type EntityManifestKind = (typeof ENTITY_MANIFEST_KINDS)[keyof typeof ENTITY_MANIFEST_KINDS];
const entityManifestKinds = new Map<string, EntityManifestKind>(Object.entries(ENTITY_MANIFEST_KINDS));

export function manifestKindFromSchema(schema: unknown): EntityManifestKind | undefined {
  if (typeof schema !== 'string') {return undefined;}
  return entityManifestKinds.get(schema);
}
