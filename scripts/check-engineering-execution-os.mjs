import { readFileSync, existsSync } from "node:fs";

const failures = [];
const osPath = "ENGINEERING_EXECUTION_OS.md";
const agentsPath = "AGENTS.md";

if (!existsSync(osPath)) {
  failures.push("Missing repository-root ENGINEERING_EXECUTION_OS.md");
} else {
  const os = readFileSync(osPath, "utf8");
  for (const phrase of [
    "Engineering Execution OS",
    "Verification Ledger",
    "TOOL DECLARATION",
    "COMPLIANCE HEADER",
    "OUTCOME",
    "INSPECT",
    "SPECIFY",
    "EXECUTE",
    "VERIFY",
    "CLOSE",
    "BLOCKED"
  ]) {
    if (!os.includes(phrase)) failures.push(`OS is missing required marker: ${phrase}`);
  }
}

if (!existsSync(agentsPath)) {
  failures.push("Missing repository-root AGENTS.md");
} else {
  const agents = readFileSync(agentsPath, "utf8");
  if (!agents.includes("ENGINEERING_EXECUTION_OS.md")) {
    failures.push("AGENTS.md does not direct agents to ENGINEERING_EXECUTION_OS.md");
  }
  if (!agents.includes("BLOCKED")) {
    failures.push("AGENTS.md does not define the stop/block behavior");
  }
}

if (failures.length) {
  console.error("ENGINEERING EXECUTION OS COMPLIANCE: FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("ENGINEERING EXECUTION OS COMPLIANCE: PASS");
  console.log("- Policy file exists and contains required markers.");
  console.log("- AGENTS.md references the policy and stop/block behavior.");
}
