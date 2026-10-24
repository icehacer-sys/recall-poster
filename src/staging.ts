// Public staging for reel media on Supabase Storage (owner decision, 24 Oct 2026).
//
// Instagram fetches video_url and cover_url itself, so the mp4 and cover must be public for the
// few minutes around publishing. They go to the dedicated PUBLIC bucket `ig-reel-staging`
// (mp4 and jpeg only, 100 MB limit) about an hour before the slot, are HEAD-checked, published,
// and then deleted. Nothing else in Supabase is touched.
//
// Credentials are read at run time, never printed:
//   1. SUPABASE_URL + SUPABASE_SECRET_KEY from the environment (GitHub Actions secrets), else
//   2. NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY from REELS_SUPABASE_ENV_FILE
//      (default W:/Projects/recall-engine/.env.local).

import { existsSync, readFileSync } from "node:fs";

export const STAGING_BUCKET = process.env.REELS_STAGING_BUCKET ?? "ig-reel-staging";
const ENV_FILE = process.env.REELS_SUPABASE_ENV_FILE ?? "W:/Projects/recall-engine/.env.local";

interface SupabaseCreds {
  url: string;
  key: string;
}

let cached: SupabaseCreds | null = null;

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function supabaseCreds(): SupabaseCreds {
  if (cached) return cached;
  const file = readEnvFile(ENV_FILE);
  const url = (process.env.SUPABASE_URL ?? file.NEXT_PUBLIC_SUPABASE_URL ?? file.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? file.SUPABASE_SECRET_KEY ?? file.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) throw new Error(`Supabase URL or secret key not found (env or ${ENV_FILE}).`);
  cached = { url, key };
  return cached;
}

function authHeaders(): Record<string, string> {
  const { key } = supabaseCreds();
  return { Authorization: `Bearer ${key}`, apikey: key };
}

/** Object path inside the bucket for one reel file. */
export function stagingPath(slug: string, file: string): string {
  return `${slug}/${file}`;
}

/** Public URL Instagram fetches (no token in it). */
export function stagingPublicUrl(slug: string, file: string): string {
  const { url } = supabaseCreds();
  return `${url}/storage/v1/object/public/${STAGING_BUCKET}/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
}

/** Same URL built from a known project URL, for the dry run (no key needed). */
export function stagingPublicUrlFor(projectUrl: string, slug: string, file: string): string {
  return `${projectUrl.replace(/\/+$/, "")}/storage/v1/object/public/${STAGING_BUCKET}/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
}

function contentTypeFor(file: string): string {
  return /\.mp4$/i.test(file) ? "video/mp4" : /\.jpe?g$/i.test(file) ? "image/jpeg" : "application/octet-stream";
}

/** Upload (or overwrite) one file. Errors carry Supabase's message, never the key. */
export async function uploadToStaging(objectPath: string, bytes: Buffer, file: string): Promise<void> {
  const { url } = supabaseCreds();
  const res = await fetch(`${url}/storage/v1/object/${STAGING_BUCKET}/${objectPath.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": contentTypeFor(file), "x-upsert": "true", "cache-control": "60" },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) throw new Error(`staging upload ${objectPath} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/** Delete files from the bucket. Returns how many Supabase reports as removed. */
export async function deleteFromStaging(objectPaths: string[]): Promise<number> {
  if (!objectPaths.length) return 0;
  const { url } = supabaseCreds();
  const res = await fetch(`${url}/storage/v1/object/${STAGING_BUCKET}`, {
    method: "DELETE",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: objectPaths }),
  });
  if (!res.ok) throw new Error(`staging delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json().catch(() => [])) as unknown[];
  return Array.isArray(json) ? json.length : 0;
}

/** Bucket settings, or null when it does not exist. */
export async function getBucket(): Promise<Record<string, unknown> | null> {
  const { url } = supabaseCreds();
  const res = await fetch(`${url}/storage/v1/bucket/${STAGING_BUCKET}`, { headers: authHeaders() });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`bucket lookup failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Create the dedicated public bucket (mp4 and jpeg only, 100 MB). Owner-authorized, 24 Oct 2026. */
export async function createBucket(): Promise<void> {
  const { url } = supabaseCreds();
  const res = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      id: STAGING_BUCKET,
      name: STAGING_BUCKET,
      public: true,
      file_size_limit: 100 * 1024 * 1024,
      allowed_mime_types: ["video/mp4", "image/jpeg"],
    }),
  });
  if (!res.ok) throw new Error(`bucket create failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
