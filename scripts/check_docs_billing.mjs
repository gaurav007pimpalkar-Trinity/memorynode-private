#!/usr/bin/env node
/**
 * Doc vs code: billing is PayU. CI must fail if billing docs still require Stripe.
 * - No Stripe env var names in billing docs except in a clearly marked historical/future section.
 * - PayU env var names must appear in QUICKSTART (billing) and PROD_SETUP_CHECKLIST.
 * See docs/IMPROVEMENT_PLAN.md Phase 1.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const docsDir = path.join(root, "docs");

const BILLING_DOCS = [
  "PROD_SETUP_CHECKLIST.md",
  "RELEASE_RUNBOOK.md",
  "BILLING_RUNBOOK.md",
  "QUICKSTART.md",
  "OPERATIONS.md",
  "API_REFERENCE.md",
  "ALERTS.md",
  "OBSERVABILITY.md",
  "TROUBLESHOOTING_BETA.md",
  "SECURITY.md",
  "PRODUCTION_DEPLOY.md",
  "PRE_PUSH_CHECKLIST.md",
];

const STRIPE_ENV_PATTERNS = [
  /STRIPE_SECRET_KEY/,
  /STRIPE_WEBHOOK_SECRET/,
  /STRIPE_PRICE_PRO/,
  /STRIPE_PRICE_TEAM/,
  /STRIPE_PORTAL/,
  /STRIPE_SUCCESS_PATH/,
  /STRIPE_CANCEL_PATH/,
];

/** Sections where Stripe is allowed (historical/future only) */
const ALLOWED_STRIPE_SECTION_HEADERS = [
  /^#+\s*Historical/i,
  /^#+\s*Future:\s*Stripe/i,
  /^#+\s*Stripe\s*\(legacy\)/i,
  /^#+\s*Optional:\s*Stripe/i,
  /<!--\s*Stripe\s*legacy\s*-->/i,
];

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return null;
  }
}

/**
 * Split content into sections by ## headers. Returns [{ header, content }].
 * Also tracks if we're inside an "allowed" Stripe section.
 */
function getSections(content) {
  const lines = content.split("\n");
  const sections = [];
  let current = { header: "(top)", content: "", allowedStripe: false };
  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const header = line;
      const allowedStripe = ALLOWED_STRIPE_SECTION_HEADERS.some((re) => re.test(header));
      sections.push(current);
      current = { header, content: "", allowedStripe };
    } else {
      current.content += line + "\n";
    }
  }
  sections.push(current);
  return sections;
}

/**
 * Check content for Stripe env vars or "Stripe" as required.
 * If file has allowed sections, only fail when violation is outside those sections.
 */
function checkContent(filePath, content) {
  const errors = [];
  const sections = getSections(content);
  for (const section of sections) {
    const text = section.content + (section.header || "");
    const isAllowedSection = section.allowedStripe;
    for (const re of STRIPE_ENV_PATTERNS) {
      if (re.test(text) && !isAllowedSection) {
        errors.push(`${filePath}: Stripe env var ${re.source} appears outside historical/future section`);
      }
    }
    // "Stripe" as required billing provider (common phrases that imply it's current)
    if (!isAllowedSection) {
      if (/\bStripe\s+(secret|webhook|key|dashboard)\b/i.test(text)) {
        errors.push(`${filePath}: Stripe mentioned as current billing (secret/webhook/key) outside historical section`);
      }
      if (/required.*Stripe|Stripe.*required/i.test(text)) {
        errors.push(`${filePath}: Stripe required outside historical section`);
      }
      if (/wrangler secret put STRIPE/i.test(text)) {
        errors.push(`${filePath}: Stripe wrangler secret outside historical section`);
      }
    }
  }
  return errors;
}

/** Require PayU vars in QUICKSTART (billing) and PROD_SETUP */
function checkPayUPresent(content, filePath) {
  const hasPayU = /PAYU_MERCHANT_KEY|PAYU_MERCHANT_SALT|PayU|PayU billing/i.test(content);
  if (!hasPayU && (filePath.includes("QUICKSTART") || filePath.includes("PROD_SETUP_CHECKLIST"))) {
    return [`${filePath}: PayU env vars or "PayU" billing must appear for production billing setup`];
  }
  return [];
}

function main() {
  const allErrors = [];
  for (const name of BILLING_DOCS) {
    const filePath = path.join(docsDir, name);
    const content = readFileSafe(filePath);
    if (content === null) continue; // file may not exist
    allErrors.push(...checkContent(filePath, content));
    allErrors.push(...checkPayUPresent(content, filePath));
  }
  // Dashboard README
  const dashboardReadme = path.join(root, "apps", "dashboard", "README.md");
  const dashContent = readFileSafe(dashboardReadme);
  if (dashContent) {
    allErrors.push(...checkContent(dashboardReadme, dashContent));
  }
  if (allErrors.length > 0) {
    console.error("check_docs_billing: billing docs must use PayU, not Stripe as required.\n");
    allErrors.forEach((e) => console.error("  " + e));
    console.error("\nFix: replace Stripe with PayU in the listed files, or move Stripe to a section titled 'Historical' or 'Future: Stripe'.");
    process.exit(1);
  }
  console.log("check_docs_billing: ok (billing docs aligned with PayU)");
  process.exit(0);
}

main();
