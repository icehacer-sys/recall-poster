// Deterministic first pass, run BEFORE any model call (threads-bot pattern: directConcern runs
// before the model). Emergencies, scan requests, and explicit personal advice requests get a
// fixed boundary line. Complaints, spam, injection, AI questions, and disputes go to the owner
// list. App questions get an approved template variant.
// Patterns cover English, Egyptian Arabic, and Franco-Arabic (Arabizi).

export type Lang = "ar" | "en";

export type RuleCategory =
  | "personal_medical"
  | "urgent"
  | "scan"
  | "complaint"
  | "dispute"
  | "spam"
  | "injection"
  | "provenance"
  | "app_question"
  | "tag_only"
  | "emoji_only";

export interface RuleHit {
  category: RuleCategory;
  reason: string;
  /** true = the owner must see it (listed in the review queue). */
  ownerReview: boolean;
  /** threads-bot boundary line to post instead of advice (once per commenter and reel). */
  boundary?: "personal" | "scan" | "urgent";
}

const AR = /[؀-ۿ]/g;
const LATIN = /[A-Za-z]/g;

/** Commenter's language. Arabic script or Arabizi (digits as letters, Egyptian words) -> "ar". */
export function detectLang(text: string): Lang {
  const ar = (text.match(AR) ?? []).length;
  const la = (text.match(LATIN) ?? []).length;
  if (ar > 0 && ar >= la * 0.3) return "ar";
  if (isArabizi(text)) return "ar";
  return "en";
}

export function isArabizi(text: string): boolean {
  const t = text.toLowerCase();
  const digitWords = (t.match(/\b[a-z]*[23578][a-z]+\b|\b[a-z]+[23578]\b/g) ?? []).filter((w) => !/^(co2|spo2|paco2|o2|h2o|b12|t3|t4|t2|d5w|ng|mg)$/.test(w));
  const egyptian = /\b(ana|enta|enty|inta|eh|ezay|izzay|keda|msh|mesh|mish|3ayez|3ayza|3ashan|ya3ni|ba2a|el7|7aga|bgd|bgad|bta3|btaa|leh|fein|fen|feen|kam|bkam|aywa|la2|tayeb|mashy|habibi|w\s?allah)\b/;
  return digitWords.length >= 1 && egyptian.test(t) || digitWords.length >= 2;
}

// ---- personal medical, the threads-bot way (threads-bot/src/concerns.ts + voice-lean.ts rule 7)
//
// threads-bot separates two things:
//   * an EXPLICIT request for personal advice (symptoms, tests, doses, treatment for me or my
//     child) gets ONE approved boundary sentence per commenter and post, never advice;
//   * a personal STORY with no request is eligible for brief empathy (the model decides), and
//     mentioning illness, a hospital, or advice someone received is not a request.
// Scan-review requests get a fixed decline and immediate-danger wording a short emergency line.

// Copied verbatim from threads-bot/src/concerns.ts requestsPersonalAdvice().
export function requestsPersonalAdviceEn(text: string): boolean {
  const request = /\b(?:should|could|can|would|do)\s+(?:i|we|my\s+(?:child|baby|son|daughter|partner))\b|\bwhat\s+(?:medicine|medication|treatment|test)\s+should\b|\bwhat should (?:i|we) do\b|\b(?:please|can you|could you)\s+(?:help|advise|diagnose|tell)\b|\b(?:i|we)\s+(?:need|want)\s+(?:medical\s+)?advice\b/i;
  const personal = /\b(?:i|me|my|we|our|us)\b/i;
  return text.split(/(?<=[.!?])\s+/).some((sentence) => {
    if (/\b(?:asked|was told|were told|was advised|were advised|doctor said|doctor told)\b/i.test(sentence) && !/\b(?:now|today|still)\b/i.test(sentence)) return false;
    return personal.test(sentence) && request.test(sentence);
  });
}

// The same idea for Egyptian Arabic and Franco-Arabic: a request about me, us, or a relative.
// Arabic has no \b in JS regex, so these are plain substrings.
const AR_PERSON = /(أنا|انا|عندي|عندى|بيحصلي|بيجيلي|بتجيلي|بعاني|باخد|ماما|مامتي|أمي|امي|بابا|أبويا|ابويا|أخويا|اخويا|أختي|اختي|ابني|إبني|بنتي|جوزي|مراتي|جدتي|جدي|تيتة|تيته|جدو|خالتي|عمتي|خالي|عمي)/;
const AR_REQUEST = /(أعمل إيه|اعمل ايه|أعمل ايه|نعمل إيه|نعمل ايه|ينفع آخد|ينفع اخد|ينفع ناخد|ينفع أديله|ينفع اديله|ينفع أديلها|ينفع اديلها|أديله|اديله|أديلها|اديلها|آخد إيه|اخد ايه|آخد كام|اخد كام|ناخد كام|الجرعة كام|جرعته كام|جرعتها كام|أروح لدكتور|اروح لدكتور|ده طبيعي|دا طبيعي|طبيعي؟|أقلق|اقلق|ساعدوني|ساعدني|محتاج نصيحة|محتاجة نصيحة|تنصحوني|تنصحني)/;
const ARABIZI_REQUEST = /\b(a3mel eh|a3ml eh|ne3mel eh|yenfa3 a5od|ynfa3 a5od|a5od eh|a5od kam|tabe3y\?|a2la2)\b/i;
const ARABIZI_PERSON = /\b(ana|3andy|3andi|mama|mamty|baba|abooya|akhooya|okhty|ebny|bnty|gozy|merati)\b/i;

export function requestsPersonalAdvice(text: string): boolean {
  return (
    requestsPersonalAdviceEn(text) ||
    (AR_PERSON.test(text) && AR_REQUEST.test(text)) ||
    (ARABIZI_PERSON.test(text) && ARABIZI_REQUEST.test(text))
  );
}

// Copied from threads-bot/src/concerns.ts directConcern(): scan-review and immediate-danger wording,
// plus the Arabic equivalents.
const SCAN_EN = /\b(?:send|dm|share|upload|review|look at|interpret|check)\b.{0,45}\b(?:my|our|my child's|my mom's|my mum's|my dad's)\b.{0,20}\b(?:scan|x.?ray|mri|ct|report|results?|labs?|tests?)\b/i;
const SCAN_AR = /(أبعتلك|ابعتلك|أبعت لك|ابعت لك|أبعتلكم|ابعتلكم|تشوفوا|تشوف|تبص|تقرا|تقرأ|تفسر).{0,40}(أشعة|اشعة|تحليل|تحاليل|التقرير|الـ ?CT|الـ ?MRI|الرسم)/;

const URGENT = /\b(?:i|my (?:child|baby|son|daughter|partner|friend|mom|mum|dad))\b.{0,20}\b(?:can(?:not|'t) breathe|(?:am|is) (?:choking|unconscious|not breathing))\b|\b(?:can(?:not|'t) breathe|not breathing|unconscious|choking|overdos\w*|suicid\w*|kill myself|want to die)\b.{0,30}\b(?:right now|now|help)\b|\b(?:suicid\w*|kill myself|want to die)\b|(مش قادر أتنفس|مش قادر اتنفس|مش قادرة تتنفس|مش قادرة أتنفس|بيتخنق|بتتخنق|مغمى عليه|مغمى عليها|فاقد الوعي|فاقدة الوعي|عايز أموت|عايز اموت|عايزة أموت|انتحار)/i;

export function isScanRequest(text: string): boolean {
  return SCAN_EN.test(text) || SCAN_AR.test(text);
}

export function isUrgent(text: string): boolean {
  return URGENT.test(text);
}

// A first-person or family health STORY (no request). Not a rule hit: it goes to the model, which
// may answer with brief empathy or skip. The hint keeps the model from treating it as a guess.
const EN_FAMILY = /\b(my|our)\s+(mom|mum|mother|dad|father|son|daughter|baby|child|kid|kids|wife|husband|sister|brother|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|partner|friend)\b/i;
const EN_SELF = /\b(i have|i've had|i had|i get|i got|i'm on|i am on|i take|i took|i was diagnosed|i'm diagnosed|i feel|i faint\w*|i pass(ed)? out|i'm allergic|i am allergic|happens to me|happened to me|same (thing )?(happens|happened) to me|this is (literally )?me)\b/i;
const HEALTH = /\b(symptoms?|confus\w*|sweat\w*|shak\w*|pain|attacks?|episodes?|allerg\w*|anaphyla\w*|rash|faint\w*|dizz\w*|seizures?|sugar|glucose|diabet\w*|hypo\w*|asthma|copd|epipen|inhaler|dose|pills?|medicine|medication|meds|insulin|sick|ill|hospital|diagnosed|breath\w*|oxygen)\b|(سكر|ضغط|حساسية|نوبة|نوبات|ربو|دوخة|أغمى|اغمى|مستشفى|دوا|علاج|أعراض|اعراض|الأعراض|الاعراض|تعبان|تعبانة|تعبانه|بيتعب|بتتعب|بيحصلها|بيحصله|بيحصلي|جرعة|حقنة)/i;

export function isPersonalStory(text: string): boolean {
  return (EN_FAMILY.test(text) || EN_SELF.test(text) || AR_PERSON.test(text)) && HEALTH.test(text);
}

const SPAM = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|app|link|me|xyz|shop|store)\b|\bdm me\b|\bcheck (my|our) (page|profile|bio)\b|\bfollow (me|back)\b|\bf4f\b|\bpromo(te)?\b|\bcollab\b|\bcrypto\b|\bbitcoin\b|\bforex\b|\binvest\w*\b|\bearn \$|\bwhats?app\b|واتساب|واتس|تابعني|تابعوني|ادخل بروفايلي|كلمني خاص|\+?\d[\d\s-]{8,}\d)/i;
const INJECTION = /\b(ignore (all |your |the )?(previous |above |prior |earlier )?(instructions|rules)|system prompt|you are now|pretend to be|act as|jailbreak|developer mode)\b|(تجاهل التعليمات|انسى التعليمات)/i;
const PROVENANCE = /\b(ai[- ]generated|made (with|by) ai|is (this|it|that) (an? )?ai|fake (video|case|doctor)|real (patient|case)\?|bot\b|automated|chatgpt|are you a (bot|robot|human))\b|(ذكاء اصطناعي|ذكاء صناعي|انت بوت|إنت بوت|ده بوت|حقيقية؟|حالة حقيقية)/i;
const COMPLAINT = /\b(scam|scammer|fraud|refund|charged|money back|waste of (money|time)|doesn'?t work|does not work|not working|broken|bug|hate this|terrible|cringe|stupid|trash|garbage|unsubscribe|stop posting|report(ed|ing)? (you|this))\b|(نصب|نصابين|حرامية|فلوسي|رجعولي|اتخصم|مش شغال|مش بيشتغل|بايظ|زبالة|سخيف|تافه|أسوأ|اسوأ|بطلوا)/i;
const DISPUTE = /\b(wrong|incorrect|not true|that'?s false|misleading|outdated|guidelines? (say|says)|actually it'?s|you('re| are) wrong|this is dangerous|bad advice|nice (protocol|guideline))\b|(غلط|مش صح|مش مظبوط|معلومة غلط|خطر الكلام ده|الـ guidelines|الجايدلاين|البروتوكول بيقول)/i;

// App questions: price, free trial, where to get it, link, sign up. Needs an app-ish word, so
// "where do you inject?" or "الجرعة كام" never trips it.
const APP_EN = /\b(price|pricing|cost|costs|how much (is|does) (it|the app|this)|subscription|subscribe|sign ?up|free trial|trial|is it free|for free|download|the app|this app|app name|which app|what app|website|link\b|where (can|do) i (get|find|download|use|practi[cs]e|try)|how (can|do) i (get|join|use|try) (it|this|the app)|discount|promo code|credits?)\b/i;
const APP_AR = /(بكام|السعر|سعره|سعرها|الاشتراك|اشتراك|أشترك|اشترك|مجاني|مجانا|مجانًا|ببلاش|فري|تجربة مجانية|فترة تجريبية|الأبلكيشن|الابلكيشن|الأبليكيشن|الابليكيشن|التطبيق|الموقع|اللينك|لينك|فين ألاقي|فين الاقي|ازاي أنزل|ازاي انزل|أنزله|انزله|نزلته|ازاي أشترك|ازاي اشترك|ازاي استخدم|ازاي أستخدم|كريدت|كريديت|credits?)/i;
const APP_ARABIZI = /\b(bkam|b kam|el se3r|else3r|mgany|magany|ebb?alash|el app|el link|elink|fein el|fen el|feen el|ezay ashtrek|ezay anzel)\b/i;

const MENTION = /(^|\s)@[\w.]+/g;

/** Which app question it is, so the reply can answer that part first (threads-bot reacts first). */
export function appIntent(text: string): "price" | "where" {
  return /\b(price|pricing|cost|costs|how much|subscription|subscribe|free|trial|discount|promo|credits?)\b|بكام|السعر|سعر|الاشتراك|اشتراك|مجاني|مجانا|مجانًا|ببلاش|فري|تجربة|كريدت|bkam|se3r|mgany|magany|balash/i.test(text)
    ? "price"
    : "where";
}

export function ruleCheck(raw: string): RuleHit | null {
  const text = raw.trim();
  const withoutMentions = text.replace(MENTION, " ").trim();
  if (!withoutMentions) return { category: "tag_only", reason: "only tags a friend (a share, nothing to answer)", ownerReview: false };
  if (!/[\p{L}\p{N}]/u.test(withoutMentions)) return { category: "emoji_only", reason: "emoji or punctuation only", ownerReview: false };
  // threads-bot directConcern(): immediate danger and scan requests are answered before any model.
  if (isUrgent(text)) return { category: "urgent", reason: "possible emergency or self-harm wording: emergency boundary line, and the owner must see this now", ownerReview: true, boundary: "urgent" };
  if (INJECTION.test(text)) return { category: "injection", reason: "tries to instruct the bot", ownerReview: true };
  if (SPAM.test(withoutMentions)) return { category: "spam", reason: "link, contact number, or promotion", ownerReview: true };
  if (isScanRequest(withoutMentions)) return { category: "scan", reason: "asks the account to review a personal scan or result: fixed decline", ownerReview: true, boundary: "scan" };
  if (APP_EN.test(withoutMentions) || APP_AR.test(withoutMentions) || APP_ARABIZI.test(withoutMentions)) {
    // A personal health request mixed into an app question still gets the boundary, never a plug.
    if (!(requestsPersonalAdvice(withoutMentions) && isPersonalStory(withoutMentions))) {
      return { category: "app_question", reason: `question about the app (${appIntent(withoutMentions)})`, ownerReview: false };
    }
  }
  // An explicit personal request about health (me, us, or a relative plus a health word): the
  // boundary line, no model call. A softer "should I..." without health words goes to the model,
  // and threads-bot's rule applies there (boundary only when the model also says personal_medical).
  if (requestsPersonalAdvice(withoutMentions) && isPersonalStory(withoutMentions)) {
    return { category: "personal_medical", reason: "explicit request for personal medical advice: boundary line only, never advice", ownerReview: true, boundary: "personal" };
  }
  if (COMPLAINT.test(text)) return { category: "complaint", reason: "complaint or hostility", ownerReview: true };
  if (PROVENANCE.test(text)) return { category: "provenance", reason: "asks if the case, video, or account is real or AI (owner answers)", ownerReview: true };
  if (DISPUTE.test(text)) return { category: "dispute", reason: "challenges the medicine in the reel (owner checks against the lecture)", ownerReview: true };
  return null;
}
