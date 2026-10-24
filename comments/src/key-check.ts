// npm run key:check
// ONE cheap call to prove the Claude for Startups key works (Claude Haiku 5.5, a few tokens).
// Prints the model, stop reason, token usage, and estimated cost. Never prints the key.
// The call is counted in spend.json like any other.

import { budgetBlock, costUsd, ledgerSummary, recordCall } from "./budget";
import { getClient } from "./reply";

const MODEL = "claude-haiku-5-5";

const blocked = budgetBlock();
if (blocked) {
  console.log(`key:check skipped: ${blocked}`);
  process.exit(0);
}
try {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 200,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
  } as never);
  recordCall(MODEL, res.usage);
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
  console.log(`key:check OK. model ${res.model}, stop ${res.stop_reason}, reply "${text.slice(0, 20)}", tokens in ${res.usage.input_tokens} out ${res.usage.output_tokens}, about $${costUsd(MODEL, res.usage).toFixed(6)}.`);
  console.log(`Budget: ${ledgerSummary()}`);
} catch (e) {
  recordCall(MODEL);
  const status = (e as { status?: number }).status;
  console.error(`key:check FAILED (${status ?? "no status"}): ${String((e as Error).message ?? e).slice(0, 160)}`);
  process.exitCode = 1;
}
