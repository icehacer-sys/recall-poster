// Orchestrator + CLI for the @recallengine reel comment bot.
//
//   npm run demo      Fixture comments through the full pipeline (rules, template, model). No
//                     Instagram access, nothing posted. Writes a markdown report with --report.
//   npm run offline   Same, but no model calls at all (rules, template, and exact-answer matching).
//   npm run dry       Reads the REAL comments under recent @recallengine reels (read-only) and prints
//                     what it would do. Nothing posted, no state written.
//   npm run live      Posts replies. Requires BOT_CONFIRM_LIVE=yes. Only inside BOT_ACTIVE_WINDOWS.
//
// Flags: --offline (no model), --report <file.md> (write the decisions as a report).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, ROOT } from "./config";
import { getComments, getMyUsername, getRecentMedia, ownReplyInThread, replyToComment, type IgComment } from "./instagram";
import { loadReels, reelForMedia, type ReelFacts } from "./reels";
import type { Decision } from "./reply";
import { State, cairoDate } from "./state";
import { claudeKey, ledgerSummary } from "./budget";
import { decide, loadTemplates, type Ctx } from "./decide";

type Mode = "fixtures" | "dry-run" | "live";

interface Args {
  mode: Mode;
  offline: boolean;
  report?: string;
}

function parseArgs(argv: string[]): Args {
  const mode: Mode = argv.includes("--live") ? "live" : argv.includes("--dry-run") ? "dry-run" : "fixtures";
  const i = argv.indexOf("--report");
  return { mode, offline: argv.includes("--offline") || !claudeKey(), report: i >= 0 ? argv[i + 1] : undefined };
}

const templates = loadTemplates();

// ---------------------------------------------------------------- report

interface Row {
  reel: string;
  user: string;
  comment: string;
  d: Decision;
  expect?: string;
}

const GUESS = new Set(["correct_guess", "partial_guess", "wrong_guess", "case_question"]);
function expectationMet(expect: string | undefined, d: Decision): boolean | undefined {
  if (!expect) return undefined;
  if (expect === d.category) return true;
  // A guess the model graded one notch differently is still a reply on the vetted facts.
  if (GUESS.has(expect) && GUESS.has(d.category)) return d.decision === "reply" || d.ownerReview;
  if (["banter", "praise", "other"].includes(expect) && ["banter", "praise", "other"].includes(d.category)) return true;
  return false;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
}

function printRow(r: Row): void {
  if (config.publicLog) {
    // Public log: no usernames, comment texts, or reply texts. The owner list is in the encrypted state.
    console.log(`  [${r.reel}] ${r.d.category} ${r.d.decision} ${r.d.language} ${r.d.source}${r.d.ownerReview ? " OWNER LIST" : ""}${r.d.retry ? " (retry later)" : ""}`);
    return;
  }
  const tag = `${r.d.category.padEnd(16)} ${r.d.decision.padEnd(5)} ${r.d.language} ${r.d.source}`;
  console.log(`  [${r.reel}] [${tag}] "${oneLine(r.comment).slice(0, 70)}"`);
  if (r.d.decision === "reply") console.log(`        -> "${r.d.reply_text}"`);
  else console.log(`        (skip${r.d.ownerReview ? ", OWNER LIST" : ""}: ${oneLine(r.d.reason)})`);
}

function writeReport(path: string, title: string, rows: Row[], extra: string[]): void {
  const replies = rows.filter((r) => r.d.decision === "reply");
  const owner = rows.filter((r) => r.d.ownerReview);
  const quiet = rows.filter((r) => r.d.decision === "skip" && !r.d.ownerReview);
  const checked = rows.filter((r) => r.expect);
  const met = checked.filter((r) => expectationMet(r.expect, r.d));
  const lines = [
    `# ${title}`,
    "",
    ...extra,
    "",
    `**${rows.length} comments:** ${replies.length} would get a reply, ${owner.length} go to the owner list, and ${quiet.length} are skipped quietly.${checked.length ? ` Expected category met for ${met.length} of ${checked.length}.` : ""}`,
    "",
    "## Would reply",
    "",
    "| Reel | Comment | Category | Lang | Reply | Source |",
    "|---|---|---|---|---|---|",
    ...replies.map((r) => `| ${r.reel} | ${oneLine(r.comment)} | ${r.d.category} | ${r.d.language} | ${oneLine(r.d.reply_text)} | ${r.d.source} |`),
    "",
    "## Owner list (skipped, needs a human)",
    "",
    "| Reel | User | Comment | Category | Why |",
    "|---|---|---|---|---|",
    ...owner.map((r) => `| ${r.reel} | ${r.user} | ${oneLine(r.comment)} | ${r.d.category} | ${oneLine(r.d.reason)} |`),
    "",
    "## Skipped quietly",
    "",
    "| Reel | Comment | Category | Why |",
    "|---|---|---|---|",
    ...quiet.map((r) => `| ${r.reel} | ${oneLine(r.comment)} | ${r.d.category} | ${oneLine(r.d.reason)} |`),
  ];
  if (checked.length) {
    lines.push("", "## Fixture expectations", "", "| Comment | Expected | Got | OK |", "|---|---|---|---|");
    for (const r of checked) lines.push(`| ${oneLine(r.comment)} | ${r.expect} | ${r.d.category} (${r.d.decision}) | ${expectationMet(r.expect, r.d) ? "yes" : "NO"} |`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n");
  console.log(`\nReport written to ${path}`);
}

// ---------------------------------------------------------------- fixtures

interface Fixture {
  reel: string;
  username: string;
  text: string;
  expect?: string;
}

async function runFixtures(args: Args): Promise<void> {
  const reels = loadReels().reels;
  const fixtures = JSON.parse(readFileSync(join(ROOT, "data", "fixtures", "comments.json"), "utf8")) as Fixture[];
  const ctx: Ctx = { offline: args.offline, modelCalls: 0, recentReplies: [], n: 0, boundaries: new Set<string>(), lastVariant: -1, templates };
  console.log(`\nFIXTURES: ${fixtures.length} synthetic comments, ${args.offline ? "OFFLINE (no model)" : `model ${config.model}, cap ${config.maxModelCalls} calls`}. Nothing is posted.\n`);
  const rows: Row[] = [];
  for (const f of fixtures) {
    const reel = reels.find((r) => r.slug === f.reel);
    if (!reel) throw new Error(`fixture reel ${f.reel} not in data/reels.json`);
    const d = await decide({ reel, username: f.username }, f.text, ctx);
    const row = { reel: f.reel, user: f.username, comment: f.text, d, expect: f.expect };
    rows.push(row);
    printRow(row);
  }
  const met = rows.filter((r) => expectationMet(r.expect, r.d)).length;
  console.log(`\nDone. ${rows.filter((r) => r.d.decision === "reply").length} would reply, ${rows.filter((r) => r.d.ownerReview).length} for the owner. Expectations met ${met}/${rows.length}. Model calls: ${ctx.modelCalls}. Budget: ${ledgerSummary()}.`);
  if (args.report) {
    writeReport(args.report, `Comment bot fixture run (${cairoDate()})`, rows, [
      `Mode: fixtures, ${args.offline ? "offline (no model)" : `model ${config.model}`}. Nothing was posted. Comments are synthetic.`,
      `Caps in force for live: ${config.perReelDailyCap} replies per reel per Cairo day, ${config.dailyCap} per day in total, ${config.perThreadCap} per comment thread.`,
    ]);
  }
}

// ---------------------------------------------------------------- dry run + live

function withinActiveHours(): boolean {
  const hh = Number(new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: config.activeTz }).format(new Date())) % 24;
  return config.activeWindows.some(([a, b]) => (a <= b ? hh >= a && hh < b : hh >= a || hh < b));
}

async function runAccount(args: Args): Promise<void> {
  const posting = args.mode === "live";
  if (posting && !config.confirmLive) {
    console.error("LIVE refused: set BOT_CONFIRM_LIVE=yes to allow replies.");
    process.exitCode = 1;
    return;
  }
  if (posting && args.offline) {
    console.error("LIVE refused: live replies need the model (CLAUDE_API_KEY not found, or --offline was given).");
    process.exitCode = 1;
    return;
  }
  if (posting && !withinActiveHours()) {
    console.log(`Outside the active window (${config.activeWindows.map(([a, b]) => `${a}-${b}`).join(", ")} ${config.activeTz}). Nothing to do.`);
    return;
  }

  const state = new State(posting);
  const reels = loadReels().reels;
  const me = await getMyUsername();
  const media = await getRecentMedia();
  const ctx: Ctx = { offline: args.offline, modelCalls: 0, recentReplies: [], n: 0, boundaries: new Set<string>(state.boundaryKeys()), lastVariant: -1, templates };
  const rows: Row[] = [];
  // A boundary that did not actually post must not count as given.
  const boundaryKind: Record<string, string> = { personal_medical: "personal", scan: "scan", urgent: "urgent" };
  const ungive = (slug: string, user: string, d: Decision) => {
    if (d.source === "template" && boundaryKind[d.category]) ctx.boundaries.delete(`${slug}|${user}|${boundaryKind[d.category]}`);
  };
  console.log(`\n${posting ? "LIVE" : "DRY-RUN (read-only)"}: @${me}, ${media.length} recent media. Caps: ${config.perReelDailyCap}/reel/day, ${config.dailyCap}/day, ${config.perThreadCap}/thread. Today so far: ${state.repliesToday()}.\n`);

  // Read every known reel's comments first. Our own replies posted today (Cairo) are counted from
  // Instagram too, so the caps hold even if the state file was lost.
  const today = cairoDate();
  const loaded: Array<{ m: (typeof media)[number]; reel: ReelFacts; convo: IgComment[]; igToday: number }> = [];
  for (const m of media) {
    const reel = reelForMedia(m, reels);
    if (!reel) {
      console.log(`Media ${m.id} (${(m.caption ?? "").split("\n")[0].slice(0, 40)}): not a known reel, skipped.`);
      continue;
    }
    try {
      const convo = await getComments(m.id);
      const igToday = convo.filter((c) => c.username === me && c.timestamp && cairoDate(Date.parse(c.timestamp)) === today).length;
      loaded.push({ m, reel, convo, igToday });
    } catch (e) {
      console.error(`  ! comments for ${m.id}: ${(e as Error).message}`);
    }
  }
  const igDayTotal = loaded.reduce((n, x) => n + x.igToday, 0);
  let postedRun = 0;

  for (const { m, reel, convo, igToday } of loaded) {
    ctx.recentReplies = convo.filter((c) => c.username === me && c.text).map((c) => c.text as string).slice(-20);
    const ours = (threadId: string) => convo.filter((c) => c.username === me && c.parentId === threadId).length;
    const candidates = convo
      .filter((c) => c.username && c.username !== me && !c.hidden && !state.handled(c.id))
      .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? "")); // oldest first: fair order
    console.log(`Reel ${reel.slug} (${m.permalink ?? m.id}): ${candidates.length} new comment(s), ${state.repliesToday(reel.slug)}/${config.perReelDailyCap} replies today.`);

    let postedHere = 0;
    for (const c of candidates) {
      const threadId = c.parentId ?? c.id;
      if (ours(threadId) >= config.perThreadCap) continue; // already answered in this thread
      // Live: state counts include this run's posts. Dry: nothing is saved, so add the would-be replies.
      const reelUsed = posting ? Math.max(state.repliesToday(reel.slug), igToday + postedHere) : Math.max(state.repliesToday(reel.slug), igToday) + postedHere;
      const dayUsed = posting ? Math.max(state.repliesToday(), igDayTotal + postedRun) : Math.max(state.repliesToday(), igDayTotal) + postedRun;
      const reelLeft = config.perReelDailyCap - reelUsed;
      const dayLeft = config.dailyCap - dayUsed;
      const d = await decide({ reel, username: c.username ?? "" }, c.text ?? "", ctx);
      const row: Row = { reel: reel.slug, user: c.username ?? "", comment: c.text ?? "", d };
      if (d.decision === "reply" && (reelLeft <= 0 || dayLeft <= 0)) {
        row.d = { ...d, decision: "skip", reason: "daily cap reached (will retry tomorrow)", ownerReview: false };
        ungive(reel.slug, c.username ?? "", d);
        rows.push(row);
        printRow(row);
        continue; // not marked handled: it can be answered after the cap resets
      }
      rows.push(row);
      printRow(row);
      if (d.ownerReview) {
        state.addReview({ at: new Date().toISOString(), reel: reel.slug, mediaId: m.id, commentId: c.id, username: c.username ?? "", text: c.text ?? "", category: d.category, reason: d.reason });
      }
      if (!posting) {
        if (d.decision === "reply") {
          postedHere++;
          postedRun++;
        }
        continue;
      }
      if (d.decision === "reply") {
        // Fresh Instagram check right before posting: never a second reply in a thread, whatever the state says.
        let answered: boolean;
        try {
          answered = await ownReplyInThread(threadId, me);
        } catch (e) {
          console.error(`    ! thread check failed for ${c.id}, not replying this run: ${(e as Error).message}`);
          ungive(reel.slug, c.username ?? "", d);
          continue;
        }
        if (answered) {
          console.log(`    thread ${threadId} already has our reply on Instagram: skipped.`);
          ungive(reel.slug, c.username ?? "", d);
          state.markHandled(c.id);
          continue;
        }
        try {
          await replyToComment(c.id, d.reply_text);
          postedHere++;
          postedRun++;
          state.countReply(reel.slug);
          state.saveBoundaries(ctx.boundaries);
          convo.push({ id: `local-${c.id}`, username: me, parentId: threadId, text: d.reply_text });
        } catch (e) {
          console.error(`    ! reply failed for ${c.id}: ${(e as Error).message}`);
          ungive(reel.slug, c.username ?? "", d);
          continue; // not handled: retried next run
        }
      }
      if (d.retry) continue; // budget or cap skip: not handled, so a later run answers it
      state.markHandled(c.id);
    }
  }

  const owner = rows.filter((r) => r.d.ownerReview);
  console.log(`\nDone. ${posting ? "Posted" : "Would post"} ${rows.filter((r) => r.d.decision === "reply").length} replies. Owner list: ${owner.length} new, ${state.pendingReview().length} pending in ${config.reviewFile}. Model calls: ${ctx.modelCalls}. Budget: ${ledgerSummary()}.`);
  if (args.report) writeReport(args.report, `Comment bot ${posting ? "live" : "dry"} run (${cairoDate()})`, rows, [`Account @${me}. ${posting ? "LIVE" : "Read-only dry run, nothing posted."}`]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "fixtures") return runFixtures(args);
  return runAccount(args);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
