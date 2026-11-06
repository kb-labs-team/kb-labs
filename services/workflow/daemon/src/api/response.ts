import type { FastifyReply } from 'fastify';
import {
  createCatalogErrorEnvelope,
  getCatalogEntry,
  type CatalogErrorRequest,
} from '@kb-labs/core-platform';
import {
  createUxFailureResult,
  createUxSuccessResult,
  type UxFailureResult,
  type UxSuccessResult,
} from '@kb-labs/core-platform/ux-result';

export type ApiSuccessResponse<T> = UxSuccessResult<T>;
export type ApiErrorResponse = UxFailureResult;
export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;


export function ok<T>(data: T): ApiSuccessResponse<Exclude<T, undefined>> {
  if (data === undefined) throw new TypeError('Workflow API success data must be defined.');
  return createUxSuccessResult(data as Exclude<T, undefined>);
}

export function fail(reply: FastifyReply, request: CatalogErrorRequest): ApiErrorResponse {
  const catalogEntry = getCatalogEntry(request.code);
  const envelope = createCatalogErrorEnvelope(request);
  reply.code(catalogEntry.httpStatus);
  return createUxFailureResult(envelope);
}
