# Forge cross-repository coding missions

## One-time setup
1. In GitHub, open Firstborn → Settings → Secrets and variables → Actions.
2. Add repository secret `FORGE_CROSS_REPO_TOKEN` containing a fine-grained token with access only to the repositories Forge is approved to modify. For Amina, grant Contents: Read and write, Pull requests: Read and write, and Metadata: Read. Do not grant administration or workflow permissions unless separately justified.
3. Keep `GITHUB_TOKEN` as the default for same-repository work. Forge checks cross-repository push permission and fails closed if it cannot verify it.

## Manual mission
1. Open Firstborn → Actions → Forge Coding Agent → Run workflow.
2. Select `coding`, enter the target repository as `owner/repo`, and provide the task title and detailed acceptance criteria.
3. Inspect the run, PR, CI checks, and execution evidence. Forge never auto-merges or deploys.

## Issue-triggered mission
Open an issue authored by the repository owner, apply `forge-task`, and include a separate exact line:
`Target repository: owner/repo`
Without that line, the mission intentionally targets the repository hosting Forge.

## Status meanings
- `BLOCKED`: target or write permission could not be verified; no repository write should occur.
- `FAILED`: the agent or verification failed.
- `PR_OPENED`: a pull request was created; this is not the same as verified, merged, or deployed.
- `PASS`: only use for checks that actually ran and passed.
