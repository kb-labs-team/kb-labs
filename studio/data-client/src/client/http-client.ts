import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse, type AxiosError } from 'axios';
import type { RequestInterceptor, ResponseInterceptor, ErrorInterceptor } from './types';
import { KBError } from '../errors/kb-error';
import { mapFetchError, mapInvalidResultEnvelope } from './error-mapper';
import { decodeUxSuccessResult, isUxResult, isUxResultCandidate } from '@kb-labs/core-platform/ux-result';
import { ulid } from 'ulid';

export class HttpClient {
  private client: AxiosInstance;
  private requestInterceptors: RequestInterceptor[] = [];
  private responseInterceptors: ResponseInterceptor[] = [];
  private errorInterceptors: ErrorInterceptor[] = [];
  private baseUrl: string;

  constructor(baseUrl: string = '', token?: string) {
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    // Axios request interceptor: add X-Request-Id
    this.client.interceptors.request.use((config) => {
      if (!config.headers['X-Request-Id']) {
        config.headers['X-Request-Id'] = ulid();
      }
      return config;
    });

    // Axios response interceptor: unwrap envelope
    this.client.interceptors.response.use(
      (response) => {
        const data = response.data;
        const requireUxResult = (response.config as AxiosRequestConfig & { requireUxResult?: boolean }).requireUxResult === true;

        // Check if response claims to use the shared result envelope.
        if (isUxResultCandidate(data)) {
          if (!isUxResult(data)) {
            return Promise.reject(mapInvalidResultEnvelope(response.status));
          }
          if (data.ok) {
            // Success envelope: unwrap and return data
            response.data = decodeUxSuccessResult(data);
            if (requireUxResult) {return response;}
          } else {
            // Error envelope: throw error
            const error = mapFetchError(data, {
              status: response.status,
              statusText: response.statusText,
            } as Response);
            return Promise.reject(error);
          }
        }

        if (requireUxResult) {
          return Promise.reject(mapInvalidResultEnvelope(response.status));
        }

        return response;
      },
      (error: AxiosError) => {
        // Transform axios error to KBError
        const body = error.response?.data;
        const status = error.response?.status ?? 500;
        const requireUxResult = (error.response?.config as AxiosRequestConfig & { requireUxResult?: boolean } | undefined)?.requireUxResult === true;
        const malformedResult = isUxResultCandidate(body) && !isUxResult(body);
        const kbError = requireUxResult && !isUxResultCandidate(body)
          ? mapInvalidResultEnvelope(status)
          : malformedResult
            ? mapInvalidResultEnvelope(status)
            : mapFetchError(body, {
          status,
          statusText: error.response?.statusText ?? 'Unknown Error',
        } as Response);
        return Promise.reject(kbError);
      }
    );
  }

  addRequestInterceptor(interceptor: RequestInterceptor): void {
    this.requestInterceptors.push(interceptor);
  }

  addResponseInterceptor(interceptor: ResponseInterceptor): void {
    this.responseInterceptors.push(interceptor);
  }

  addErrorInterceptor(interceptor: ErrorInterceptor): void {
    this.errorInterceptors.push(interceptor);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Gateway URL without the versioned API path, for absolute streaming URLs. */
  getGatewayBaseUrl(): string {
    return gatewayBaseFromApiBase(this.baseUrl);
  }

  async fetch<T>(path: string, options: AxiosRequestConfig = {}): Promise<T> {
    return this.fetchWithUxPolicy<T>(path, options, false);
  }

  /** Fetch a JSON route that must return a valid shared UX result envelope. */
  async fetchUx<T>(path: string, options: AxiosRequestConfig = {}): Promise<T> {
    return this.fetchWithUxPolicy<T>(path, options, true);
  }

  private async fetchWithUxPolicy<T>(path: string, options: AxiosRequestConfig, requireUxResult: boolean): Promise<T> {
    try {
      // Apply custom request interceptors (if any)
      const config: AxiosRequestConfig & { requireUxResult?: boolean } = {
        url: path,
        ...options,
        requireUxResult,
      };

      // Note: Custom interceptors work with FetchOptions (headers as Headers object)
      // but axios uses plain objects. If you need custom interceptors, adapt them here.

      const response: AxiosResponse<T> = await this.client.request<T>(config);

      // Apply custom response interceptors (if any)
      // Note: These expect Response objects from fetch API
      // You may need to adapt or remove these if not used

      return response.data;
    } catch (error) {
      const kbError = error instanceof KBError ? error : mapFetchError(error);
      throw await this.processError(kbError);
    }
  }

  private async processError(error: KBError): Promise<never> {
    let processedError = error;
    for (const interceptor of this.errorInterceptors) {
      processedError = await interceptor(processedError);
    }
    throw processedError;
  }
}

/** Resolve an absolute streaming URL base from the HTTP client's versioned API base. */
export function gatewayBaseFromApiBase(
  baseUrl: string,
  origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
): string {
  const url = new URL(baseUrl || '/', origin);
  if (url.pathname === '/api/v1') {
    url.pathname = '';
  } else if (url.pathname.endsWith('/api/v1/')) {
    url.pathname = url.pathname.slice(0, -'/api/v1/'.length);
  } else if (url.pathname.endsWith('/api/v1')) {
    url.pathname = url.pathname.slice(0, -'/api/v1'.length);
  }
  const pathname = url.pathname === '/' ? '' : url.pathname;
  return url.origin === 'http://localhost' && !baseUrl.startsWith('http')
    ? `${pathname}${url.search}`
    : `${url.origin}${pathname}${url.search}`;
}
