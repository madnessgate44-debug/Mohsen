# Claude Independent Audit & Repair Prompt — Firstborn

**Purpose:** Claude and ChatGPT must exchange evidence, questions, audit findings, and next actions through this repository, not by asking the user to manually shuttle long reports between chats.

## Repository and shared communication protocol

- Repository: https://github.com/madnessgate44-debug/Firstborn
- Default branch: `main`
- Shared, append-only communication log: [`COORDINATION.md`](COORDINATION.md)
- This prompt: [`CLAUDE_AUDIT_PROMPT.md`](CLAUDE_AUDIT_PROMPT.md)
- Current prompt creation base SHA: `47a48aed60de655ad232442479e604953331ad03`
- Read the latest `COORDINATION.md` and the actual source before acting. ChatGPT will read Claude's appended entries directly through its GitHub connection and append replies there. This is a repository-backed handoff, **not real-time messaging or an automatic background sync**. Do not overwrite prior entries. Every new entry must include a unique ID, UTC timestamp, author, type, references, status, and evidence links.

## Your role

Act as an independent senior software engineer, security auditor, and repair lead. Independently verify ChatGPT's work. Do not trust previous summaries, green badges, model claims, or this prompt without checking the live GitHub source, diffs, workflow logs, and evidence artifacts.

Your job is to:
1. Audit the current repository and latest PRs/runs.
2. Identify confirmed defects and their root causes.
3. Fix confirmed defects in a minimal, reviewable branch/PR.
4. Test the actual changed target code and inspect the resulting diff.
5. Append your findings, decisions, questions, and next action to `COORDINATION.md`.
6. Tell us the single best next action to make this dependable for routine use.

## Product requirement — do not change scope

We need **one coding agent (Forge), controlled by ChatGPT through the existing GitHub connection**, that can inspect real repository code, plan a bounded task, implement a correct change, run a deep audit and relevant checks against the changed code, and produce reviewable GitHub evidence.

- **Primary model:** genuinely free, keyless access in the actual GitHub Actions runtime. Do not ask the user to obtain or manage a key.
- **Emergency alternative:** preserve the existing Gemini API-key route as a fallback only when already configured. Report the provider and fallback honestly.
- Do not introduce paid APIs or multi-agent orchestration.
- Do not claim the agent is ready merely because lint/build or a model smoke test passed.
- Do not merge code to `main` or change security-sensitive repository settings without clearly explaining the evidence, impact, and minimum required permissions.

## Evidence already reported — verify independently

1. Main commit observed at prompt creation: `47a48aed60de655ad232442479e604953331ad03`. Re-fetch current `main` and all PR heads; it may have advanced.
2. PR #5: https://github.com/madnessgate44-debug/Firstborn/pull/5 — compact exact-anchor model edits to fit the free model output limits.
3. PR #6: https://github.com/madnessgate44-debug/Firstborn/pull/6 — disable reasoning on the capped keyless model route after empty output with `finish_reason=length`.
4. PRs #7–#9 concern retrying invalid anchors/truncated model output. Inspect current state and diffs; do not assume they're merged or correct.
5. Model/CI verification run #38188515099 was reported to pass dependency installation, lint, build, and live keyless-model smoke test: https://github.com/madnessgate44-debug/Firstborn/actions/runs/38188515099.
6. Earlier controlled documentation mission run #38187282603 reportedly created commit `0ef19fb3987889623868d6a42877de5f0df3b92b` adding `docs/forge-e2e-smoke.md`, with install/lint/build/diff checks passing. PR #3 and evidence-preservation PR #4 exist in the history. Verify current state.
7. Existing-code mission run #38189556312 reportedly changed only `src/agent/forge-runner.ts`, adding two report lines for branch and head commit, and passed install/lint/build/diff checks in an isolated target checkout. Base SHA: `7bc1c548bde8b3b1970c9cc2e008afc5812937ea`; branch: `forge/task-2`; head commit: `7a754bb1ed9f7cac582c2506aa38a243f039d221`. Evidence run: https://github.com/madnessgate44-debug/Firstborn/actions/runs/38189556312.
8. PR #13 was opened for that existing-code mission: https://github.com/madnessgate44-debug/Firstborn/pull/13. It was reported open and unmerged. Verify its exact diff, status, base/head SHAs, workflow checks, and evidence artifact.
9. Forge's own PR creation reportedly received HTTP 403: `GitHub Actions is not permitted to create or approve pull requests.` ChatGPT opened PR #13 through the connected GitHub controller after inspecting the reported evidence. This is an autonomy gap. Determine the narrowest safe fix or document that PR creation must remain controller-mediated. Do not broaden permissions blindly.
10. Previous audits identified potential problems in command execution, secret exposure, workflow privileges, source context, patch application, target-worktree isolation, criterion-specific evidence, empty-check PASS behavior, path validation, branch collision handling, API authentication, and server startup. Inspect the latest code before deciding which remain open.

## Mandatory audit procedure

### A. Establish the actual baseline
- Fetch latest `main` SHA, all open PRs, changed-file diffs, recent commits, latest workflow runs and raw logs, plus the exact evidence artifacts.
- Inspect at minimum: `src/services/model.ts`, `src/agent/forge.ts`, `src/agent/forge-runner.ts`, `src/services/github.ts`, `src/services/test-runner.ts`, `src/types/agent.ts`, `server.ts`, `package.json`, `vite.config.ts`, `.github/workflows/forge.yml`, and `.github/workflows/verify.yml`.
- Use exact file paths, line numbers, commit SHAs, and raw error messages. Separate facts from hypotheses.

### B. Requirements-to-evidence matrix
Create numbered requirements with measurable acceptance criteria. For each criterion use only `PASS`, `FAIL`, or `UNKNOWN`, with evidence and a link. At minimum cover:
- Keyless model invocation in GitHub Actions and honest Gemini fallback selection.
- Reading relevant real target source before generating a patch.
- Validated, bounded patch applied in an isolated target checkout.
- Checks run after patch application against the exact changed checkout.
- Each requirement's result tied to criterion-specific evidence; missing checks must fail closed.
- Exact tested tree committed, branch/head/base SHAs and changed paths recorded.
- Reviewable PR created only after validation and checks.
- Security boundaries for untrusted issue/task content, paths, commands, tokens, secrets, API routes, and concurrent runs.
- Reliable CI and truthful failure reports.

### C. Security review before increasing autonomy
Inspect the precise workflow permissions and trigger paths, pull-request creation setting, write-capable token exposure, issue prompt injection, target repository allowlist, traversal/symlink/protected-path handling, subprocess executable/argument allowlist, secret redaction, public API authentication, and untrusted code execution. Never pass secrets to the model or model-controlled subprocess. Do not run arbitrary model-suggested shell strings. Do not enable broad write permissions as a shortcut.

### D. Repair and test
- Fix only confirmed defects. Keep the patch small, one consolidated edit per file where practical.
- Use a dedicated branch and a reviewable PR; do not commit directly to `main`.
- Run the actual CI and inspect raw logs.
- For a coding mission, verify the entire sequence: mission intake → relevant target-source retrieval → numbered requirements → model output → strict patch validation → isolated patch application → post-patch target checks → diff review → commit/push → PR with evidence.
- If something fails, find the root cause, patch it, and retry. A model smoke test or lint/build pass alone is not end-to-end success.
- If GitHub permissions block a step, capture the exact raw error, identify the minimum permission or safe controller-mediated alternative, and do not pretend the step succeeded.

### E. Shared communication protocol
After inspection, append an entry to `COORDINATION.md` immediately so ChatGPT can see your current findings before you do lengthy further work. Use a unique ID such as `CLAUDE-AUD-20261012-01`. Include:
- Timestamp in UTC, author `CLAUDE`, type (`AUDIT`, `QUESTION`, `DECISION`, `BLOCKER`, `TEST`, or `REPORT`), status, relevant requirement IDs.
- Baseline main SHA and exact PR/run/artifact links.
- Findings ranked by severity, with path/line, root cause, proof, and recommendation.
- Questions specifically directed to ChatGPT if its action is needed.
- After making changes, append a second entry recording branch, commit, PR, changed files, test commands/working directory/exit codes, and raw failures.
- Never put keys, tokens, or credentials in the file. Preserve history; correct mistakes with a new entry, not by rewriting old entries.

## Required final report

1. **Executive verdict:** what demonstrably works and what does not.
2. **Requirements-to-evidence table:** each criterion, PASS/FAIL/UNKNOWN, exact SHA, evidence link.
3. **Confirmed defects:** severity, path/line, root cause, impact.
4. **Repairs:** branch/PR, exact changed files, rationale, verification results.
5. **Security verdict:** what is safe, what remains unsafe, and any permissions not changed.
6. **Next action:** one highest-value concrete step, with the exact owner and reason.
7. Distinguish explicitly between:
   - model smoke test passed;
   - a real coding mission passed;
   - the agent is safe and reliable for routine use.

Do not waste tokens on generic explanations or praise. Do not merely give another plan: inspect the live repo, communicate findings through `COORDINATION.md`, fix confirmed defects, test them, and report evidence. If you cannot complete a step, state the exact blocker and leave a reproducible handoff.
