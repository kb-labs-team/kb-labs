export type ArtifactKind = 'file' | 'json' | 'markdown' | 'binary' | 'dir' | 'log';

export interface ArtifactExample {
  summary?: string;
  payload?: unknown;
}

export interface PluginArtifactContract {
  id: string;
  kind: ArtifactKind;
  description?: string;
  /**
   * Relative path or glob pattern describing where the artifact is materialised.
   * Example: "artifacts/template/hello/greeting.json"
   */
  pathPattern?: string;
  /**
   * IANA media type describing the artifact. Example: "application/json".
   */
  mediaType?: string;
  /**
   * Reference to a schema describing the artifact payload. Can be a URI or package export.
   */
  schemaRef?: string;
  /**
   * Optional example payload to help documentation and tooling.
   */
  example?: ArtifactExample;
}

export type ArtifactContractsMap = Record<string, PluginArtifactContract>;

