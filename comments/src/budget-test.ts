// Offline checks of the spend guard and the key source. No network, no cost.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "budget-"));
process.env.BOT_SPEND_FILE = join(dir, "spend.json");
process.env.BOT_DAILY_MODEL_CALLS = "3";
process.env.BOT_MONTHLY_USD = "5";
process.env.BOT_CLAUDE_ENV_FILE = join(dir, "missing.env");
delete process.env.CLAUDE_API_KEY;
process.env.ANTHROPIC_API_KEY = "must-be-ignored";

const b = await import("./budget");
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
};

check("ANTHROPIC_API_KEY is never used as the Claude key", b.claudeKey() === null);
check("Sonnet 5.5 price: 1M in + 1M out = $12", Math.abs(b.costUsd("claude-sonnet-5-5", { input_tokens: 1e6, output_tokens: 1e6 }) - 12) < 1e-9);
check("cache reads cost 10% of input", Math.abs(b.costUsd("claude-sonnet-5-5", { cache_read_input_tokens: 1e6 }) - 0.2) < 1e-9);
check("fresh ledger allows a call", b.budgetBlock() === null);
for (let i = 0; i < 3; i++) b.recordCall("claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 100 });
check("daily cap blocks after 3 calls", /daily model-call cap/.test(b.budgetBlock() ?? ""), b.budgetBlock() ?? "");

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
writeFileSync(process.env.BOT_SPEND_FILE, JSON.stringify({ month: today.slice(0, 7), monthUsd: 5.01, monthCalls: 900, day: today, dayCalls: 0 }));
check("monthly guard blocks at $5", /monthly spend guard/.test(b.budgetBlock() ?? ""), b.budgetBlock() ?? "");
writeFileSync(process.env.BOT_SPEND_FILE, JSON.stringify({ month: "2000-01", monthUsd: 99, monthCalls: 900, day: "2000-01-01", dayCalls: 99 }));
check("a new month and day reset both counters", b.budgetBlock() === null);

console.log(fails ? `\n${fails} budget check(s) FAILED` : "\nall budget checks passed");
process.exitCode = fails ? 1 : 0;
