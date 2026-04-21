import { HOSTED_CANONICAL_TOOL_NAMES } from "../registry/registerAllTools.js";

/** Regex from docs/PLAN.md §4.1 — noun_verb except approved register exceptions. */
const NOUN_VERB_PATTERN = /^[a-z]+(_[a-z]+){1,3}$/;

/** Explicit register from docs/PLAN.md §4.1 — single-word recall tool. */
const REGISTER_EXCEPTIONS = new Set<string>(["search"]);

function validateCanonicalToolNames(): string[] {
  const violations: string[] = [];
  for (const name of HOSTED_CANONICAL_TOOL_NAMES) {
    if (REGISTER_EXCEPTIONS.has(name)) continue;
    if (!NOUN_VERB_PATTERN.test(name)) violations.push(name);
  }
  return violations;
}

function main(): void {
  const bad = validateCanonicalToolNames();
  if (bad.length > 0) {
    console.error(
      `[mcp-core] noun_verb lint failed — names must match ${NOUN_VERB_PATTERN} or be listed in REGISTER_EXCEPTIONS (currently: ${[...REGISTER_EXCEPTIONS].join(", ")}).`,
    );
    console.error(`Violating tools: ${bad.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("[mcp-core] noun_verb lint OK for HOSTED_CANONICAL_TOOL_NAMES.");
}

main();
