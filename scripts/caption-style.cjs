// Owner caption style (case 15 edit, 8 Nov 2026): one sentence per block, blank line between blocks.
const SPLIT = /(?<=[^\sA-E]\s*[.؟?])\s+(?=\S)/u; // sentence end, not an option label like "B."
function splitSentences(line) {
  const out = []; let rest = line.trim();
  const re = /(\.)\s+(?=\S)/gu; let m, last = 0; // a question and its short answer stay on one line
  while ((m = re.exec(rest))) {
    const before = rest.slice(0, m.index);
    if (/(^|\s)[A-E]$/.test(before)) continue;          // "B. Pulmonary" is a label, not a sentence end
    out.push(rest.slice(last, m.index + 1).trim()); last = m.index + m[0].length;
  }
  out.push(rest.slice(last).trim());
  return out.filter(Boolean);
}
module.exports = function style(caption) {
  const lines = caption.replace(/\r/g, "").split("\n").map(l => l.replace(/\s+$/, "")).filter(l => !/clinician oversight/i.test(l));
  const blocks = []; let group = null; let first = true;
  const flush = () => { if (group) { blocks.push(group.join("\n")); group = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    if (first) { blocks.push(l.replace(/([^\sA-E])\.\s+/gu, "$1 ")); first = false; continue; } // hook: no period between its two parts
    if (/^[A-E]\.\s/.test(l)) { if (!group || group.kind !== "opt") { flush(); group = []; group.kind = "opt"; } group.push(l); continue; }
    if (/^⚠️/.test(l)) { flush(); group = [l.replace(/\.\s+(?=\S)/u, " ")]; group.kind = "spoil"; continue; }
    if (group && group.kind === "spoil" && /^\.$/.test(l)) { group.push(l); continue; }
    if (group && group.kind === "spoil" && /^الإجابة\s/.test(l)) { group.push(l); flush(); continue; }
    flush();
    if (/^📚/.test(l)) { const i = l.indexOf(":"); blocks.push(l.slice(0, i + 1) + l.slice(i + 1).replace(/:/g, "")); continue; }
    if (/^#/.test(l)) { blocks.push(l); continue; }
    for (const s of splitSentences(l)) blocks.push(s);
  }
  flush();
  return blocks.join("\n\n");
};
if (require.main === module) {
  const fs = require("fs"); process.stdout.write(module.exports(fs.readFileSync(process.argv[2], "utf8")));
}
