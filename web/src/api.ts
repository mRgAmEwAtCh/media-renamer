import type { ApiPath, ApiRequest, ApiResponse } from '../../lib/api-types.ts';

/** POST JSON to the server; throws the server's error message. A lost login goes back to the login page. */
export async function api<P extends ApiPath>(path: P, body: ApiRequest<P>): Promise<ApiResponse<P>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (response.status === 401) location.href = '/login';
  if (!response.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${response.status})`);
  return data as ApiResponse<P>;
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
