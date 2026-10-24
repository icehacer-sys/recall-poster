// Cloud mode media (owner GO, 24 Oct 2026): the reel mp4 and cover live in the PRIVATE Supabase
// bucket `ig-reel-media`. Seat 1's local `npm run reels:upload` puts them there and writes a signed
// URL (valid REELS_SIGN_DAYS, default 7) into reels/<slug>/reel.json. The GitHub workflow only reads
// those URLs, so it never needs a Supabase key. The key is read at run time on the laptop
// (staging.ts supabaseCreds) and never printed.

import { supabaseCreds } from "./staging.js";

export const MEDIA_BUCKET = process.env.REELS_MEDIA_BUCKET ?? "ig-reel-media";

function authHeaders(): Record<string, string> {
  const { key } = supabaseCreds();
  return { Authorization: `Bearer ${key}`, apikey: key };
}

function objectUrl(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Make sure the private media bucket exists. Never makes it public. */
export async function ensureMediaBucket(): Promise<void> {
  const { url } = supabaseCreds();
  const res = await fetch(`${url}/storage/v1/bucket/${MEDIA_BUCKET}`, { headers: authHeaders() });
  if (res.ok) {
    const b = (await res.json()) as { public?: boolean };
    if (b.public) throw new Error(`bucket ${MEDIA_BUCKET} is PUBLIC. It must be private. Fix it in Supabase first.`);
    return;
  }
  const create = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id: MEDIA_BUCKET, name: MEDIA_BUCKET, public: false, file_size_limit: 100 * 1024 * 1024, allowed_mime_types: ["video/mp4", "image/jpeg"] }),
  });
  if (!create.ok) throw new Error(`bucket create failed (${create.status}): ${(await create.text()).slice(0, 200)}`);
  console.log(`Created private bucket ${MEDIA_BUCKET}.`);
}

export async function uploadMedia(path: string, bytes: Buffer, contentType: string): Promise<void> {
  const { url } = supabaseCreds();
  const res = await fetch(`${url}/storage/v1/object/${MEDIA_BUCKET}/${objectUrl(path)}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": contentType, "x-upsert": "true", "cache-control": "300" },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) throw new Error(`upload ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/** Signed GET URL for one object, valid `seconds`. */
export async function signMedia(path: string, seconds: number): Promise<string> {
  const { url } = supabaseCreds();
  const res = await fetch(`${url}/storage/v1/object/sign/${MEDIA_BUCKET}/${objectUrl(path)}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: seconds }),
  });
  if (!res.ok) throw new Error(`sign ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const rel = j.signedURL ?? j.signedUrl;
  if (!rel) throw new Error(`sign ${path}: no signedURL in the response`);
  return rel.startsWith("http") ? rel : `${url}/storage/v1${rel.startsWith("/") ? "" : "/"}${rel}`;
}

/** Delete objects (local cleanup only). */
export async function deleteMedia(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const { url } = supabaseCreds();
  const res = await fetch(`${url}/storage/v1/object/${MEDIA_BUCKET}`, {
    method: "DELETE",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!res.ok) throw new Error(`delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/**
 * Reachability and byte size of a URL without downloading it: HEAD first, then a 1-byte range GET
 * (signed URLs may not answer HEAD). No token is ever sent.
 */
export async function probeUrl(u: string): Promise<{ ok: boolean; status: number; bytes?: number; type?: string }> {
  try {
    const h = await fetch(u, { method: "HEAD", redirect: "follow" });
    const len = h.headers.get("content-length");
    if (h.ok && len) return { ok: true, status: h.status, bytes: Number(len), type: h.headers.get("content-type") ?? undefined };
  } catch {
    /* fall through to the range GET */
  }
  try {
    const g = await fetch(u, { headers: { Range: "bytes=0-0" }, redirect: "follow" });
    const total = g.headers.get("content-range")?.match(/\/(\d+)\s*$/)?.[1];
    const len = g.headers.get("content-length");
    await g.body?.cancel().catch(() => undefined);
    const ok = g.status === 200 || g.status === 206;
    return { ok, status: g.status, bytes: total ? Number(total) : g.status === 200 && len ? Number(len) : undefined, type: g.headers.get("content-type") ?? undefined };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Signed URL with its token hidden, for logs. */
export function redactUrl(u: string): string {
  return u.replace(/([?&]token=)[^&]+/, "$1<hidden>");
}
