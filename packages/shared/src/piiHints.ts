/** Lightweight client hints — not a DLP engine; opt-in via request header on ingest. */

export type PiiHintKind = "email" | "phone";

const EMAIL_RE = /\b[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}\b/;
/** US 10-digit and common +country digit runs (conservative, may miss edge formats). */
const PHONE_RE = /(?:\+\d{10,15}\b)|(?:\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b)/;

export function detectPiiHints(text: string): PiiHintKind[] {
  const input = typeof text === "string" ? text : "";
  const out: PiiHintKind[] = [];
  if (EMAIL_RE.test(input)) out.push("email");
  if (PHONE_RE.test(input)) out.push("phone");
  return Array.from(new Set(out));
}
