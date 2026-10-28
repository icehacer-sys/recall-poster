#!/usr/bin/env node
// Renders the YouTube channel art from assets/youtube/src/*.html with Chromium on the NVIDIA GPU
// (owner rule, 18 Oct 2026: every render on the GTX 1050 Ti, never the CPU or the integrated GPU).
// Run it through the heavy slot on the laptop:
//
//   node D:/Temp/ClaudeCode/process/heavy-slot.cjs yt-assets --cwd W:/Projects/recall-poster-yt -- node scripts/render-youtube-assets.mjs
//
// Playwright is borrowed from the recall-engine checkout (PLAYWRIGHT_DIR), so this repo gains no
// dependency. Fonts come from the creator kit (YT_FONT_DIR). Stops loudly when Chrome is not drawing on
// the NVIDIA card, unless YT_RENDER_ALLOW_CPU=1.
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "assets", "youtube", "src");
const OUT = join(ROOT, "assets", "youtube");
const PW = process.env.PLAYWRIGHT_DIR ?? "W:/Projects/recall-engine/node_modules/playwright";
const FONT_DIR = process.env.YT_FONT_DIR ?? "W:/Recall Engine Review/creator-kit-20261023/04-fonts";
// ANGLE on Direct3D 11, GPU rasterisation everywhere, the high-performance adapter (same flags as
// recall-engine scripts/intro-video/gpu.cjs).
const GPU_ARGS = ["--use-angle=d3d11", "--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--force_high_performance_gpu"];

const JOBS = [
  { src: "banner.html", out: "banner-2560x1440.png", width: 2560, height: 1440, maxBytes: 6 * 1024 * 1024 },
  { src: "banner.html?guides=1", out: "banner-safe-area-preview.png", width: 2560, height: 1440, maxBytes: 6 * 1024 * 1024 },
  { src: "avatar.html", out: "profile-800x800.png", width: 800, height: 800, maxBytes: 4 * 1024 * 1024 },
];

function fail(msg) {
  console.error(`STOPPED: ${msg}`);
  process.exit(1);
}

async function assertNvidia(browser) {
  const cdp = await browser.newBrowserCDPSession();
  const { gpu, commandLine } = await cdp.send("SystemInfo.getInfo");
  await cdp.detach();
  const renderer = gpu.auxAttributes?.glRenderer || "(none)";
  const st = gpu.featureStatus || {};
  const hw = (f) => String(st[f] || "").startsWith("enabled");
  if (/NVIDIA/i.test(renderer) && hw("gpu_compositing") && hw("rasterization")) return renderer;
  const exe = (commandLine.match(/^"([^"]+)"/)?.[1] ?? commandLine.split(/\s+--/)[0]).trim();
  const msg = [
    "Chrome is not rendering on the NVIDIA GTX 1050 Ti.",
    `  GL_RENDERER: ${renderer}; rasterization: ${st.rasterization}; compositing: ${st.gpu_compositing}`,
    `  browser: ${exe}`,
    "Fix: Windows Settings > System > Display > Graphics > Add desktop app > that browser > High performance.",
  ].join("\n");
  if (process.env.YT_RENDER_ALLOW_CPU !== "1") fail(msg);
  console.warn(`WARNING ${msg}\nYT_RENDER_ALLOW_CPU=1 is set: continuing without the NVIDIA GPU.`);
  return renderer;
}

const require = createRequire(import.meta.url);
if (!existsSync(PW)) fail(`Playwright not found at ${PW} (set PLAYWRIGHT_DIR).`);
const { chromium } = require(PW);
for (const f of ["HankenGrotesk-Medium.ttf", "HankenGrotesk-SemiBold.ttf"]) if (!existsSync(join(FONT_DIR, f))) fail(`${f} not found in ${FONT_DIR} (set YT_FONT_DIR).`);

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
try {
  const renderer = await assertNvidia(browser);
  console.log(`GPU: ${renderer}`);
  const fontUrl = (f) => pathToFileURL(join(FONT_DIR, f)).href;
  const fontCss = `
    @font-face { font-family: "Hanken Grotesk"; font-weight: 500; src: url("${fontUrl("HankenGrotesk-Medium.ttf")}") format("truetype"); }
    @font-face { font-family: "Hanken Grotesk"; font-weight: 600; src: url("${fontUrl("HankenGrotesk-SemiBold.ttf")}") format("truetype"); }`;
  for (const job of JOBS) {
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
    const [file, query] = job.src.split("?");
    await page.goto(`${pathToFileURL(join(SRC, file)).href}${query ? `?${query}` : ""}`, { waitUntil: "load" });
    await page.addStyleTag({ content: fontCss });
    const fontsOk = await page.evaluate(async () => {
      await Promise.all([document.fonts.load('500 50px "Hanken Grotesk"'), document.fonts.load('600 50px "Hanken Grotesk"')]);
      await document.fonts.ready;
      const imgs = [...document.images];
      await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => i.addEventListener("load", r, { once: true })))));
      return { hanken: document.fonts.check('500 50px "Hanken Grotesk"'), images: imgs.every((i) => i.naturalWidth > 0) };
    });
    if (!fontsOk.images) fail(`${job.src}: an image did not load`);
    if (file === "banner.html" && !fontsOk.hanken) fail("Hanken Grotesk did not load");
    const out = join(OUT, job.out);
    await page.screenshot({ path: out, type: "png", clip: { x: 0, y: 0, width: job.width, height: job.height } });
    const bytes = statSync(out).size;
    if (bytes > job.maxBytes) fail(`${job.out} is ${(bytes / 1e6).toFixed(1)} MB (YouTube limit ${(job.maxBytes / 1048576).toFixed(0)} MB)`);
    console.log(`  ${job.out}: ${job.width} x ${job.height}, ${(bytes / 1024).toFixed(0)} KB`);
    await page.close();
  }
} finally {
  await browser.close();
}
