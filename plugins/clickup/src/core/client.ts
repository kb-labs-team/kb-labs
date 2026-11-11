const BASE_URL = 'https://api.clickup.com/api/v2';

export class ClickUpApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClickUpApiError';
  }
}

export async function clickupFetch<T>(
  path: string,
  apiKey: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    let code = 'UNKNOWN';
    let message = `ClickUp API error ${res.status}`;
    try {
      const body = await res.json() as { err?: string; ECODE?: string };
      if (body.err) { message = body.err; }
      if (body.ECODE) { code = body.ECODE; }
    } catch {
      // ignore parse error
    }
    throw new ClickUpApiError(res.status, code, message);
  }

  const text = await res.text();
  if (!text) { return {} as T; }
  return JSON.parse(text) as T;
}
