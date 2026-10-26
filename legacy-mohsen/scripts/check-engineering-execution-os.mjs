import { readFileSync, existsSync } from "node:fs";
const failures = [];
if (!existsSync("ENGINEERING_EXECUTION_OS.md")) failures.push("Missing ENGINEERING_EXECUTION_OS.md");
else {
 const os = readFileSync("ENGINEERING_EXECUTION_OS.md", "utf8");
 for (const marker of ["Verification Ledger","TOOL DECLARATION","COMPLIANCE HEADER","OUTCOME","INSPECT","SPECIFY","EXECUTE","VERIFY","CLOSE","BLOCKED"]) if (!os.includes(marker)) failures.push("Missing OS marker: " + marker);
}
if (!existsSync("AGENTS.md")) failures.push("Missing AGENTS.md");
else {
 const agents = readFileSync("AGENTS.md", "utf8");
 if (!agents.includes("ENGINEERING_EXECUTION_OS.md")) failures.push("AGENTS.md does not reference the OS");
 if (!agents.includes("BLOCKED")) failures.push("AGENTS.md lacks stop/block behavior");
}
if (failures.length) { console.error("ENGINEERING EXECUTION OS COMPLIANCE: FAIL"); failures.forEach(x => console.error("- " + x)); process.exitCode = 1; }
else console.log("ENGINEERING EXECUTION OS COMPLIANCE: PASS");
