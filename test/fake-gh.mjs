// Stand-in for the GitHub CLI in test/yt-test.mjs: records each call and what arrived on stdin.
import { appendFileSync, readFileSync } from "node:fs";

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  /* no stdin */
}
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args: process.argv.slice(2), stdin: input }) + "\n");
