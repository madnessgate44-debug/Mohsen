# GitHub Account Reverse-Engineering Register

**Owner scope:** `madnessgate44-debug`  
**Inventory date:** 2026-10-26  
**Purpose:** Establish an evidence-led map of the 21 repositories visible through the connected GitHub account before deeper repository-by-repository audits.

## Evidence rules

- **Observed** means the repository listing, README, or package manifest was directly retrieved.
- **Inferred** means the purpose is suggested by a repository name or prior project context but has not been confirmed from the current repository source.
- **Unknown / limited** means the available source was insufficient; do not treat the entry as a completed code audit.
- Repository sizes below are GitHub metadata values, not file counts.
- This register is not a claim that every file in every repository has been reverse-engineered. Full file-level review, tests, workflows, deployment configuration, and cross-repository dependencies must be captured in separate evidence reports.

## Repository register

| Repository | Visibility | GitHub size | Observed purpose / status | Evidence and unresolved work |
|---|---:|---:|---|---|
| `G` | Private | 8 | **Unknown / limited.** Small repository; README and package manifest were not retrievable in this pass. | [U] Inspect root tree and entrypoints using an authenticated path. |
| `Mission-runner` | Public | 473 | **Observed:** AI-agnostic GitHub execution arm. A JSON mission in `.missions/inbox/` triggers target changes, allowed validations, push, and a result record. | [V] README retrieved. Verify workflow permissions, mission schema enforcement, target allowlist, tests, and whether `ARM_GITHUB_TOKEN` exists without exposing its value. |
| `Meshmesh` | Public | 153 | **Observed:** README says “Self updater meshmesh”; details remain sparse. | [V] README retrieved. Reverse-engineer updater, trust boundary, update source, rollback, and tests. |
| `Meshmesh-` | Public | 335 | **Unknown / limited:** README only names the repository. | [V] README retrieved. Inspect actual code and compare against `Meshmesh`. |
| `Blind-sniper-` | Public | 1361 | **Observed:** GitHub Pages static preview of Miss Noor. README states server APIs from Amina are absent, so tutor/speech use offline fallback. | [V] README retrieved. Compare preview assets against Amina build and verify live behavior. |
| `Revenue-hunter` | Public | 9 | **Unknown / limited:** minimal README; no package manifest retrieved. | [V] README retrieved. Inspect files, workflow, and intended user-visible outcome. |
| `Gahiz` | Private | 112 | **Inferred from project context:** English-language mobile interview-pressure simulator for Egyptian BPO candidates. Current README was not retrievable; package manifest indicates a Vite/React server app. | [I] Verify product scope from source, payment flow, scoring, data handling, and test coverage. Private repo needs a confirmed read path for a full audit. |
| `Mr-baleegh` | Public | 137 | **Observed:** Android/Gradle project; README describes an app with `app/src`, schemas, Gradle build, and assets. | [V] README retrieved. Inspect app screens, domain logic, backend/API integration, signing, and tests. |
| `Foryra` | Public | 834 | **Observed:** Mission Runner / browser-first developer operating system, with a PWA and legacy Android companion assets. It also contains the Engineering Execution OS document. | [V] README and execution OS retrieved. Compare the claimed client-side execution model with actual browser, storage, and GitHub integration code. |
| `smart-farm` | Public | 186 | **Observed:** Arabic RTL farm-management application with land/crop, worker, financial, inventory, livestock, irrigation, reporting, and Baleegh assistant areas. | [V] README retrieved. Verify persistence, accounting correctness, authorization, and voice-action confirmation. |
| `Money-slave` | Public | 87 | **Observed:** Google AI Studio app scaffold; README points to an AI Studio app and requires a Gemini API key for local execution. | [V] README and package manifest retrieved. Establish the actual product behavior and whether secret handling is safe. |
| `Mohsen` | Public | 59 | **Observed before replication:** AI Studio app scaffold. This repository is now the candidate host for the Firstborn/Forge replica; original files are preserved under `legacy-mohsen/` on the replica branch. | [V] Root README/package manifest retrieved. The replica branch is not yet merged; check PR state before calling this the active Forge host. |
| `brain` | Public | 1057 | **Observed:** Brain V1 mission orchestration service with persistent state, API, event history, approval foundations, artifact storage, and recovery configuration. README explicitly limits the documented worker to a deterministic Markdown brief; it does not claim web research, model calls, or repository edits. | [V] README retrieved. Verify which workers are actually wired and test API authorization and persistence. |
| `Brand-building-skills` | Public | 155 | **Observed:** reusable AI-agent skills for brand strategy, naming, identity, voice, positioning, messaging, and launch. | [V] README retrieved. Inspect each skill and check consistency, duplication, and install instructions. |
| `Brand-manager` | Public | 9 | **Observed:** minimal AI Studio scaffold README. | [V] README retrieved. Product purpose and implementation completeness remain unknown. |
| `Amina` | Public | 161352 | **Observed from current project context:** Miss Noor school-companion application; package manifest exposes a large test suite across adaptive teaching, teaching, integrity, gates, onboarding, and related areas. README was not retrievable by the current file path. | [V] package manifest retrieved; [C] product scope from established project context. High-priority full audit: build, API routes, curriculum ingestion, tutoring loop, security, and actual user flow. |
| `Gah1` | Public | 98 | **Observed:** Vite/React/Node server scaffold from package manifest; README was not retrievable. | [V] package manifest retrieved. Determine whether it duplicates Gahiz or is a separate build. |
| `Mohamy` | Private | 94 | **Unknown / limited:** README not retrievable; package manifest indicates a Vite/React/Node server app. | [V] package manifest retrieved. Private repository needs full source audit and relationship mapping. |
| `brain-chat-log` | Public | 203 | **Observed:** README describes Brain X as a conversational multi-agent software-company orchestrator and claims GitHub administration, browser engine, and keyless model fallback. Those are product claims, not independently verified capabilities. | [V] README retrieved. Compare every claimed capability with executable code, credentials, workflows, tests, and live end-to-end evidence. |
| `brain-e2e-probe` | Private | 9 | **Observed:** minimal repository name/README indicates an E2E probe; details are insufficient. | [V] README retrieved. Inspect actual test purpose and its connection to Brain. |
| `Firstborn` | Public | 1088 | **Observed:** Forge coding agent with GitHub Actions entrypoints, isolated branches/worktrees, model-backed plans/patches, safe test runner, permission policy, audit/company paths, and browser tooling. A real cross-repository mission was blocked before branch creation because write permission could not be verified. | [V] README, workflow, agent code, and run #40299936932 logs retrieved. Fix target authorization and prove branch/PR read-back; current PR #135 remains unmerged. |

## Account-level findings

1. **Multiple overlapping execution systems exist.** Firstborn/Forge, Mission-runner, Foryra, Brain, and Brain X overlap in mission orchestration, GitHub writes, auditing, and agent execution. Their capabilities must be compared from implementation and live evidence, not README claims.
2. **Private-repository coverage is incomplete.** The current connection can list private repos and retrieve some manifests, but not all README/source paths. This register does not claim those projects are fully inspected.
3. **Several repositories are scaffolds or have sparse descriptions.** `Meshmesh-`, `Revenue-hunter`, `Brand-manager`, `Gah1`, `Mohamy`, and `brain-e2e-probe` need code-level purpose verification.
4. **The Miss Noor deployment has an architectural split.** Amina contains the application/server code; Blind-sniper- is documented as a static preview without those API routes.
5. **Forge cross-repository writes are not proven.** Issue #137 triggered the real workflow, but the agent returned `BLOCKED` with no branch/PR because permission was not verified for Mohsen. See the exact run: https://github.com/madnessgate44-debug/Firstborn/actions/runs/40299936932.
6. **Replica is a snapshot, not a Git fork.** The current Mohsen candidate copies Firstborn's tracked file snapshot and preserves Mohsen's former files under `legacy-mohsen/`. It does not copy Git history, repository secrets/settings, or external integrations. The executable workflow file is a compatibility entrypoint; source workflow copies are retained under `replica-source/.github/workflows/` where the Actions token cannot install them into executable workflow paths.

## Required deep-audit coverage

For each repository, the final evidence package must include:

- Full file inventory and default branch/base commit SHA.
- Entry points, architecture, data flow, external dependencies, and integrations.
- Every workflow's trigger, permissions, secret names (never values), artifact outputs, and failure behavior.
- Build, lint, tests, and runtime smoke tests with exact outputs and timestamps.
- Security review: authentication, authorization, input validation, secret handling, SSRF, command execution, unsafe browser actions, and data exposure.
- Requirement-to-evidence matrix; observed defects vs inferred risks separated.
- Cross-repository dependencies and duplicate/obsolete implementations.
- A status of `VERIFIED`, `PARTIAL`, `BLOCKED`, or `NOT RUN` per check.

Until those artifacts exist for every repository, account-wide reverse engineering remains **PARTIAL**, not complete.
