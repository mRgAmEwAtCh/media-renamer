/** POST JSON to the server; throws the server's error message. A lost login goes back to the login page. */
export async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) location.href = '/login';
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}
