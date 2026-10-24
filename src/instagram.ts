// Instagram publishing client. Posts a carousel (or single image) via the
// Instagram Graph API:
//   1. create an item container per image, and wait for each to be FINISHED
//   2. create the carousel container referencing the item ids
//   3. poll the carousel container until status_code === "FINISHED"
//   4. media_publish the container -> published media id
//
// Reused from the proven xray-poster, hardened: child containers are polled before the
// carousel is assembled, the polling budget is larger (remote image fetches can be slow),
// and the access token is sent only via the Authorization header (never in the URL).
//
// Slide image URLs MUST be public at publish time (Meta fetches them server-side).

import { config, requireEnv } from "./config.js";

// ~2 minutes of polling: remote raw.githubusercontent.com fetches of 6 images can be slow.
const STATUS_TRIES = 30;
const STATUS_DELAY_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST a form-encoded body to the IG Graph API and return the parsed JSON. */
async function igPost(path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${config.igBase}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("IG_ACCESS_TOKEN")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Instagram POST ${path} returned non-JSON (${res.status}): ${text}`);
  }
  if (!res.ok || json?.error) {
    throw new Error(`Instagram POST ${path} failed (${res.status}): ${json?.error?.message ?? text}`);
  }
  return json;
}

/** GET from the IG Graph API (Authorization header only) and return the parsed JSON. */
async function igGet(path: string): Promise<any> {
  const res = await fetch(`${config.igBase}${path}`, {
    headers: { Authorization: `Bearer ${requireEnv("IG_ACCESS_TOKEN")}` },
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Instagram GET ${path} returned non-JSON (${res.status}): ${text}`);
  }
  if (!res.ok || json?.error) {
    throw new Error(`Instagram GET ${path} failed (${res.status}): ${json?.error?.message ?? text}`);
  }
  return json;
}

/** Poll a container until it reports FINISHED, throwing on ERROR/EXPIRED/timeout. */
async function waitForContainer(containerId: string, tries = STATUS_TRIES, delayMs = STATUS_DELAY_MS): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const { status_code } = await igGet(`/${containerId}?fields=status_code`);
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new Error(`Instagram container ${containerId} status ${status_code}`);
    }
    await sleep(delayMs);
  }
  throw new Error(`Instagram container ${containerId} not FINISHED after ${tries} tries`);
}

/** Publish a finished container and return the published media id. */
async function publishContainer(containerId: string): Promise<string> {
  await waitForContainer(containerId);
  const { id } = await igPost("/me/media_publish", { creation_id: containerId });
  return id;
}

/**
 * Publish a carousel post. Creates an item container per image (waiting for each to be ready),
 * then a CAROUSEL container referencing them, polls until ready, and publishes. Returns the id.
 */
export async function publishCarousel(imageUrls: string[], caption: string): Promise<string> {
  if (imageUrls.length < 2) {
    throw new Error(`publishCarousel needs 2-10 images, got ${imageUrls.length}`);
  }
  if (imageUrls.length > 10) {
    throw new Error(`publishCarousel accepts at most 10 images, got ${imageUrls.length}`);
  }
  const childIds: string[] = [];
  for (const image_url of imageUrls) {
    const { id } = await igPost("/me/media", { image_url, is_carousel_item: "true" });
    await waitForContainer(id); // each child must finish fetching its image before we reference it
    childIds.push(id);
  }
  const { id: containerId } = await igPost("/me/media", {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption,
  });
  return publishContainer(containerId);
}

/** Publish a single image post (no carousel). Returns the published media id. */
export async function publishImage(imageUrl: string, caption: string): Promise<string> {
  const { id: containerId } = await igPost("/me/media", { image_url: imageUrl, caption });
  return publishContainer(containerId);
}

// ---------------------------------------------------------------------------
// Reels. A REELS container fetches the video from a public video_url (Meta does the
// download server-side), so the file must be reachable when the container is created.
// Video processing is slower than images: poll every 15 s for up to 10 minutes.

const REEL_STATUS_TRIES = 40;
const REEL_STATUS_DELAY_MS = 15_000;

/** The exact form fields sent to POST /me/media for a reel. Printed verbatim by the dry run. */
export interface ReelContainerParams {
  media_type: "REELS";
  video_url: string;
  caption: string;
  share_to_feed: "true" | "false";
  cover_url?: string;
  thumb_offset?: string;
}

/** Create a REELS container and return its id (does not publish). */
export async function createReelContainer(params: ReelContainerParams): Promise<string> {
  const body: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") body[k] = String(v);
  const { id } = await igPost("/me/media", body);
  return id;
}

/** Current status_code of a container (IN_PROGRESS | FINISHED | PUBLISHED | ERROR | EXPIRED). */
export async function containerStatus(containerId: string): Promise<string> {
  const { status_code } = await igGet(`/${containerId}?fields=status_code`);
  return String(status_code ?? "");
}

/** Wait for a reel container to finish processing, then media_publish it. Returns the media id. */
export async function publishReelContainer(containerId: string): Promise<string> {
  await waitForContainer(containerId, REEL_STATUS_TRIES, REEL_STATUS_DELAY_MS);
  const { id } = await igPost("/me/media_publish", { creation_id: containerId });
  return id;
}

/** Posts used in the current 24 h window, so a publish never runs into the API cap blind. */
export async function publishingQuotaUsage(): Promise<number | null> {
  try {
    const json = await igGet("/me/content_publishing_limit?fields=quota_usage");
    const usage = json?.data?.[0]?.quota_usage;
    return typeof usage === "number" ? usage : null;
  } catch {
    return null;
  }
}

/** Recent media on the account (newest first), used to spot a reel that is already live. */
export async function recentMedia(): Promise<Array<{ id: string; caption?: string; timestamp?: string; permalink?: string; media_product_type?: string }>> {
  const json = await igGet("/me/media?fields=id,caption,timestamp,permalink,media_product_type&limit=25");
  return Array.isArray(json?.data) ? json.data : [];
}
