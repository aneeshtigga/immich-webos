// Fetch a binary endpoint with Bearer auth and return a blob: object URL.
import { getToken } from '../auth/store';

export async function authedBlobUrl(url: string): Promise<string> {
  const t = getToken();
  const res = await fetch(url, {
    headers: t ? { Authorization: `Bearer ${t}` } : {},
  });
  if (!res.ok) throw new Error(`media ${res.status} for ${url}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
