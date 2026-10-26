# R7 Risk Assessment — Permission Control Plane ("ultimate control")

## Purpose
R7 was the deferred request to give the agent "ultimate control" over GitHub
operations. This document records the risk assessment that policy requires before
any permission boundary is changed, and describes the control plane that was
implemented instead of a blanket permission increase.

## What was implemented
A single, pure, auditable decision function — `evaluatePermissionPolicy` in
`src/agent/policy.ts` — that every GitHub write step consults before acting
(branch creation, commit, pull request). The default profile preserves the
existing least-privilege behaviour: commit to an isolated `forge/task-*` branch
and open a reviewable PR. Nothing merges.

### Profiles
| Profile | Branch write | Commit | Open PR | Merge |
| :-- | :-- | :-- | :-- | :-- |
| `readonly` | no | no | no | no |
| `sandbox` | yes | yes | no | no |
| `review` (default) | yes | yes | yes | no |
| `publish` | yes | yes | yes | no |

`merge` is intentionally never granted by this module for any profile.

### Controls
- `FORGE_PERMISSION_PROFILE` selects the profile (default `review`).
- `FORGE_REQUIRE_HUMAN_APPROVAL=true` caps the effective profile at `sandbox`,
  so the agent may prepare a reviewed branch but cannot open a PR without a
  human decision.
- Only branches under `FORGE_ALLOWED_BRANCH_PREFIX` (default `forge/task-`) may
  be pushed; `FORGE_FORBIDDEN_BRANCHES` (default `main,master`) can never be
  pushed, even on the highest profile.
- `FORGE_ALLOWED_REPOS` restricts which repositories may be acted on.
- Caller consent (`allowPrCreation`) remains mandatory: no consent means no write.

## Risk assessment
- **Blast radius**: bounded to an isolated branch; the default branch is denied
  by policy, not only by convention.
- **Escalation risk**: broadening authority requires an explicit profile change
  and (optionally) is blocked by the human-approval cap. There is no path by
  which the agent widens its own authority.
- **Merge risk**: eliminated — merge is not representable in any profile.
- **Auditability**: the decision is a pure function with unit tests
  (`tests/policy.test.ts`), and every mission logs the effective profile and reason.
- **Secrets**: unchanged; no credentials are introduced or exposed.

## Human sign-off
Enabling anything above `sandbox` for unattended runs should be an explicit
operator decision. The human-approval cap exists so that the safe default
requires no change to repository settings.
