/** A file's bytes; a non-OK reply is an error (never hand a 404 page to a decoder). */
export async function fetchBytes(url: string, init?: RequestInit): Promise<ArrayBuffer> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return r.arrayBuffer();
}
