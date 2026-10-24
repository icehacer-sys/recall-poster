// npm run facts:sync
// Refresh the vetted context of every reel in data/reels.json from its own library item:
//   v2-story/<storyDay>/sources.md  -> stem, keyed answer, library takeaway, and the sourced
//                                      on-screen lines (rows whose source is NOT story dressing)
//   READY-TO-SCHEDULE/<slug>/caption-instagram.txt -> captionStart (first caption line), used to
//                                      match a live reel to its facts.
// Hand-authored fields (acceptedAnswers, partialAnswers, medicalTerms, mediaId, shortcode) are kept.
// Reads local files only. No network, no keys.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import type { ReelsFile } from "./reels";

function field(md: string, label: string): string {
  const m = md.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*"?(.+?)"?\\s*$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
}

function sourcedOnScreen(md: string): string[] {
  const out: string[] = [];
  const table = md.split("## Every number and clinical claim")[1]?.split(/\n## /)[0] ?? "";
  for (const line of table.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || !/^\d/.test(cells[1])) continue;
    const [, , onScreen, source] = cells;
    if (/story dressing/i.test(source)) continue; // invented details are never facts
    if (/cliffhanger/i.test(onScreen)) continue;
    out.push(onScreen.replace(/\s*;\s*/g, ". "));
  }
  return out;
}

function dressing(md: string): string {
  const parts = md.split(/\n## /).filter((sec) => /^(Story dressing|Satire dressing)/.test(sec));
  return parts
    .map((sec) => sec.split("\n").slice(1).join(" "))
    .join(" ")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function firstLine(path: string): string {
  if (!existsSync(path)) return "";
  const txt = readFileSync(path, "utf8").replace(/^﻿/, "");
  return txt.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

function main(): void {
  const data = JSON.parse(readFileSync(config.reelsFile, "utf8")) as ReelsFile;
  for (const r of data.reels) {
    const src = join(data.storySource, r.storyDay, "sources.md");
    if (!existsSync(src)) {
      console.log(`  ${r.slug}: ${src} not found, kept as is`);
      continue;
    }
    const md = readFileSync(src, "utf8");
    r.stem = field(md, "Stem") || r.stem;
    r.answer = field(md, "Keyed answer") || r.answer;
    r.takeaway = field(md, "Library takeaway") || r.takeaway;
    r.onScreen = sourcedOnScreen(md);
    r.storyDressing = dressing(md);
    const cap = firstLine(join(data.readySource, r.slug, "caption-instagram.txt"));
    if (cap) r.captionStart = cap;
    console.log(`  ${r.slug}: answer "${r.answer}", ${r.onScreen.length} sourced on-screen lines, caption "${r.captionStart.slice(0, 40)}"`);
  }
  writeFileSync(config.reelsFile, JSON.stringify(data, null, 2) + "\n");
  console.log("facts:sync done. Review the diff of data/reels.json before going live.");
}

main();
