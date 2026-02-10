#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const MAX_FILE_BYTES = 2_000_000;
const EXCLUDED_TRACKED_FILES = new Set(["scripts/secret_scan.mjs", "staged_files.txt"]);
const EXCLUDED_PREFIXES = [
  "node_modules/",
  ".git/",
  ".pnpm-store/",
  ".tmp/",
  "dist/",
  "build/",
  "coverage/",
];

const TOKEN_RULES = [
  { name: "mn_live token", re: /\bmn_live_[A-Za-z0-9_-]{20,}\b/g },
  { name: "mn_a token", re: /\bmn_a[A-Za-z0-9_-]{20,}\b/g },
  { name: "sk token", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
];

const ENV_ASSIGN_RULES = [
  {
    name: "SUPABASE_SERVICE_ROLE_KEY assignment",
    key: "SUPABASE_SERVICE_ROLE_KEY",
    re: /\bSUPABASE_SERVICE_ROLE_KEY\b\s*[:=]\s*["'`]?([^\s"'`,]+)/g,
    minLength: 20,
  },
  {
    name: "MASTER_ADMIN_TOKEN assignment",
    key: "MASTER_ADMIN_TOKEN",
    re: /\bMASTER_ADMIN_TOKEN\b\s*[:=]\s*["'`]?([^\s"'`,]+)/g,
    minLength: 16,
  },
  {
    name: "OPENAI_API_KEY assignment",
    key: "OPENAI_API_KEY",
    re: /\bOPENAI_API_KEY\b\s*[:=]\s*["'`]?([^\s"'`,]+)/g,
    minLength: 16,
  },
];

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function runGit(args, allowFailure = false) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) return String(error.stdout || "");
    throw error;
  }
}

function isAllZeroSha(value) {
  return !value || /^0+$/.test(value);
}

function redact(value) {
  if (!value) return "***";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function cleanValue(value) {
  return value.replace(/^[("'{`]+/, "").replace(/[)"'}`,;]+$/, "");
}

function isLikelyPlaceholder(value) {
  const lower = value.toLowerCase();
  if (!lower) return true;
  if (lower === "stub" || lower === "dummy" || lower === "admin") return true;
  if (lower === "staging_admin_token" || lower === "prod_admin_token") return true;
  if (lower.includes("dev_admin")) return true;
  if (lower.startsWith("mn_dev_")) return true;
  if (lower.endsWith("_admin_token")) return true;
  if (lower.includes("example")) return true;
  if (lower.includes("placeholder")) return true;
  if (lower.includes("changeme")) return true;
  if (lower.includes("replace")) return true;
  if (lower.endsWith("_test") || lower.endsWith("_stub")) return true;
  if (lower === "..." || /^x{6,}$/.test(lower)) return true;
  if (lower.startsWith("${{") || lower.startsWith("${") || lower.startsWith("$(")) return true;
  if (lower.startsWith("<") && lower.endsWith(">")) return true;
  return false;
}

function shouldSkipFile(filePath) {
  const normalized = normalizePath(filePath);
  if (EXCLUDED_TRACKED_FILES.has(normalized)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function addFinding(findings, finding) {
  const key = `${finding.source}|${finding.file}|${finding.line}|${finding.rule}|${finding.match}`;
  if (!findings.seen.has(key)) {
    findings.seen.add(key);
    findings.items.push(finding);
  }
}

function inspectLine(line, filePath, lineNumber, source, findings) {
  if (line.includes("${{ secrets.") || line.includes("${{ env.")) {
    return;
  }
  const exampleContext = /(sample|example|fixture|dummy|placeholder)/i.test(line);

  for (const rule of TOKEN_RULES) {
    const matches = line.matchAll(rule.re);
    for (const match of matches) {
      const candidate = match[0];
      if (exampleContext) continue;
      if (isLikelyPlaceholder(candidate)) continue;
      addFinding(findings, {
        source,
        file: filePath,
        line: lineNumber,
        rule: rule.name,
        match: candidate,
      });
    }
  }

  for (const rule of ENV_ASSIGN_RULES) {
    const matches = line.matchAll(rule.re);
    for (const match of matches) {
      const rawValue = cleanValue(match[1] || "");
      if (!rawValue || rawValue.length < rule.minLength) continue;
      if (isLikelyPlaceholder(rawValue)) continue;
      if (rule.key === "OPENAI_API_KEY" && !/^sk-/i.test(rawValue)) continue;
      addFinding(findings, {
        source,
        file: filePath,
        line: lineNumber,
        rule: rule.name,
        match: rawValue,
      });
    }
  }
}

function scanDiffAddedLines(diffText, source, findings) {
  const lines = diffText.split(/\r?\n/);
  let currentFile = "";
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).trim();
      if (rawPath === "/dev/null") {
        currentFile = "";
        currentLine = 0;
      } else {
        currentFile = normalizePath(rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath);
      }
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      currentLine = Number(hunk[1]);
      continue;
    }

    if (!currentFile || shouldSkipFile(currentFile)) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      inspectLine(line.slice(1), currentFile, currentLine, source, findings);
      currentLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    if (!line.startsWith("\\")) {
      currentLine += 1;
    }
  }
}

function scanTrackedFiles(findings) {
  const listed = runGit(["ls-files", "-z"], true);
  const files = listed.split("\u0000").filter(Boolean).map(normalizePath);

  for (const file of files) {
    if (shouldSkipFile(file)) continue;

    let content;
    try {
      const buffer = fs.readFileSync(file);
      if (buffer.length > MAX_FILE_BYTES) continue;
      if (buffer.includes(0)) continue;
      content = buffer.toString("utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      inspectLine(lines[i], file, i + 1, "tracked", findings);
    }
  }
}

function parseArgs(argv) {
  const options = {
    mode: "staged",
    base: "",
    head: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ci") options.mode = "ci";
    if (arg === "--staged") options.mode = "staged";
    if (arg === "--base" && i + 1 < argv.length) {
      options.base = argv[i + 1];
      i += 1;
    }
    if (arg === "--head" && i + 1 < argv.length) {
      options.head = argv[i + 1];
      i += 1;
    }
  }

  return options;
}

function printResult(findings, mode) {
  if (findings.items.length === 0) {
    console.log(`Secret scan passed (${mode}).`);
    return;
  }

  console.error("Secret scan failed. Potential secret-like values were detected:");
  for (const finding of findings.items) {
    console.error(
      ` - [${finding.source}] ${finding.file}:${finding.line} ${finding.rule} (${redact(finding.match)})`,
    );
  }
  console.error("Remove secrets from tracked files/diffs and use Cloudflare Dashboard secrets instead.");
  process.exit(1);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const findings = { seen: new Set(), items: [] };

  if (options.mode === "staged") {
    const stagedDiff = runGit(["diff", "--cached", "--no-color", "--unified=0"], true);
    if (stagedDiff.trim()) {
      scanDiffAddedLines(stagedDiff, "staged", findings);
    }
    printResult(findings, "staged diff");
    return;
  }

  scanTrackedFiles(findings);

  if (!isAllZeroSha(options.base) && !isAllZeroSha(options.head)) {
    const rangeDiff = runGit(
      ["diff", "--no-color", "--unified=0", `${options.base}..${options.head}`],
      true,
    );
    if (rangeDiff.trim()) {
      scanDiffAddedLines(rangeDiff, "range", findings);
    }
  }

  printResult(findings, "ci");
}

main();
