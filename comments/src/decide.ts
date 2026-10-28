// One comment -> one decision, shared by the Instagram bot (index.ts) and the YouTube bot
// (yt-run.ts): rules first, then the approved templates, then the model, then the guards in
// reply.ts. Moved out of index.ts unchanged (28 Oct 2026) so both platforms use the same safety path.

import { readFileSync } from "node:fs";
import { config } from "./config";
import type { ReelFacts } from "./reels";
import { appIntent, detectLang, isPersonalStory, requestsPersonalAdvice, ruleCheck, type Lang } from "./rules";
import { modelBroken, modelDecide, offlineDecide, ruleDecision, type Category, type Decision, type Platform } from "./reply";
import { budgetBlock } from "./budget";

type Approved<T> = { approved: boolean } & T;
type AppTemplates = Record<"en" | "ar", Approved<{ price: string[]; where: string[] }>>;
export interface Templates {
  app_question: AppTemplates;
  /** YouTube wording: the link lives on the channel page, never in a reply (Shorts comment links are dead text). */
  youtube_app_question?: AppTemplates;
  boundary: Record<"personal" | "scan" | "urgent", Record<"en" | "ar", Approved<{ text: string }>>>;
}

export function loadTemplates(): Templates {
  return JSON.parse(readFileSync(config.templatesFile, "utf8")) as Templates;
}

export interface Ctx {
  offline: boolean;
  modelCalls: number;
  recentReplies: string[];
  n: number;
  /** Boundary lines already given ("reel|user|kind"), so each commenter gets one per reel. */
  boundaries: Set<string>;
  /** Index of the last app variant used, so consecutive app replies differ. */
  lastVariant: number;
  /** Which platform's prompt and app templates to use (default instagram). */
  platform?: Platform;
  templates: Templates;
}

export interface Who {
  reel: ReelFacts;
  username: string;
}

/** App reply: an approved variant for this language and intent, never the one used just before. */
function appReply(lang: Lang, text: string, ctx: Ctx): Decision {
  const group = ctx.platform === "youtube" ? ctx.templates.youtube_app_question : ctx.templates.app_question;
  const t = group?.[lang];
  if (!t?.approved) return ruleDecision("app_question", lang, `app question: the ${ctx.platform === "youtube" ? "YouTube " : ""}template for this language is not approved yet`, true);
  const intent = appIntent(text);
  const pool = t[intent];
  let i = [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % pool.length;
  if (pool.length > 1 && i === ctx.lastVariant) i = (i + 1) % pool.length;
  ctx.lastVariant = i;
  return { decision: "reply", category: "app_question", language: lang, reply_text: pool[i], reason: `approved app reply (${intent}, variant ${i + 1})`, source: "template", ownerReview: false };
}

/**
 * threads-bot boundary (concerns.ts concernAcknowledgment): the approved line, at most once per
 * commenter and reel, never advice. Always listed for the owner too. An unapproved language
 * (Arabic until the owner approves it) is a plain skip for the owner.
 */
function boundaryReply(kind: "personal" | "scan" | "urgent", category: Category, lang: Lang, who: Who, reason: string, ctx: Ctx): Decision {
  const key = `${who.reel.slug}|${who.username}|${kind}`;
  const line = ctx.templates.boundary[kind][lang];
  if (ctx.boundaries.has(key)) return ruleDecision(category, lang, `${reason} | boundary already given to this commenter on this reel`, true);
  if (!line?.approved) return ruleDecision(category, lang, `${reason} | ${lang === "ar" ? "Arabic" : "this"} boundary line awaits owner approval: "${line?.text ?? ""}"`, true);
  ctx.boundaries.add(key);
  return { decision: "reply", category, language: lang, reply_text: line.text, reason: `${reason} | approved boundary line`, source: "template", ownerReview: true };
}

export async function decide(who: Who, text: string, ctx: Ctx, priorExchange?: { commenter: string; bot: string }): Promise<Decision> {
  const { reel } = who;
  const lang = detectLang(text);
  const hit = ruleCheck(text);
  if (hit?.category === "app_question") return appReply(lang, text, ctx);
  if (hit?.boundary) return boundaryReply(hit.boundary, hit.category, lang, who, hit.reason, ctx);
  if (hit) return ruleDecision(hit.category, lang, hit.reason, hit.ownerReview);
  if (text.trim().length < config.minCommentLength) return ruleDecision("other", lang, "too short", false);

  if (ctx.offline) return offlineDecide(reel, text, lang, ctx.n++);
  const blocked = ctx.modelCalls >= config.maxModelCalls ? `model call cap (${config.maxModelCalls}) reached for this run` : modelBroken ? `model unavailable this run (${modelBroken.slice(0, 60)})` : budgetBlock();
  if (blocked) return { ...ruleDecision("other", lang, `${blocked}: retried on a later run`, false), retry: true };
  ctx.modelCalls++;
  let d = await modelDecide({ reel, comment: text, lang, recentReplies: ctx.recentReplies, priorExchange, personalStory: isPersonalStory(text), platform: ctx.platform });
  // threads-bot reply.ts: personal_medical gets the boundary only with an explicit request.
  // Without one it is skipped (threads-bot rechecks once first; we skip straight away).
  if (d.category === "personal_medical") {
    d = requestsPersonalAdvice(text)
      ? boundaryReply("personal", "personal_medical", lang, who, `model: ${d.reason}`, ctx)
      : ruleDecision("personal_medical", lang, `no explicit advice request, never a boundary or advice: ${d.reason}`, true);
  }
  if (!config.educational && d.decision === "reply" && (d.category === "wrong_guess" || d.category === "case_question")) {
    d = { ...d, decision: "skip", reply_text: "", reason: `${d.reason} | educational replies off`, ownerReview: true };
  }
  if (!config.caseQuestions && d.decision === "reply" && d.category === "case_question") {
    d = { ...d, decision: "skip", reply_text: "", reason: `case question held for the owner (BOT_CASE_QUESTIONS=off). Draft: "${d.reply_text}"`, ownerReview: true };
  }
  if (d.decision === "reply" && d.source === "model") ctx.recentReplies.push(d.reply_text);
  return d;
}
