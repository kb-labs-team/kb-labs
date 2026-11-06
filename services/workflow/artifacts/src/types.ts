export type ArtifactInput =
  | string
  | Buffer
  | Uint8Array
  | NodeJS.ReadableStream

export type ArtifactOutput = Buffer

export interface ArtifactReference {
  path: string
  size?: number
  contentType?: string
  modifiedAt?: Date
}

export interface ArtifactClient {
  produce(path: string, input: ArtifactInput): Promise<void>
  consume(path: string): Promise<ArtifactOutput>
  list?(prefix?: string): Promise<ArtifactReference[]>
  basePath?: () => string
}





