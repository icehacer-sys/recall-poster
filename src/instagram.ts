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
async function waitForContainer(containerId: string): Promise<void> {
  for (let i = 0; i < STATUS_TRIES; i++) {
    const { status_code } = await igGet(`/${containerId}?fields=status_code`);
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new Error(`Instagram container ${containerId} status ${status_code}`);
    }
    await sleep(STATUS_DELAY_MS);
  }
  throw new Error(`Instagram container ${containerId} not FINISHED after ${STATUS_TRIES} tries`);
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
