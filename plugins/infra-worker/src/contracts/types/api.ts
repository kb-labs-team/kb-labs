export type SchemaFormat = 'zod' | 'json-schema' | 'openapi';

export interface SchemaReference {
  /**
   * Reference to the schema. Can be a URI, npm package export, or local module path.
   */
  ref: string;
  /**
   * Describes the format of the referenced schema.
   */
  format?: SchemaFormat;
  description?: string;
}

export interface RestRouteContract {
  id: string;
  method: string;
  path: string;
  description?: string;
  request?: SchemaReference;
  response?: SchemaReference;
  produces?: string[];
  consumes?: string[];
}

export interface RestApiContract {
  basePath: string;
  routes: Record<string, RestRouteContract>;
}

export interface ApiContract {
  rest?: RestApiContract;
}

