# Cross-Project Conversation Sync Protocol

Status: **Adopted as the working protocol; automatic cross-app capture is not yet implemented.**

## Objective

Preserve project-relevant conversations as durable, source-faithful records in the repository for the project being discussed. This applies to every coding/software/product-building project, not only Amina.

## Required behavior for each project conversation

1. **Identify the project and repository** at the start of substantive coding/product work. If the mapping is uncertain, ask one focused question rather than guessing.
2. **Capture decisions as they happen when the current tools and source content permit it.** Write a dated session log or transcript incrementally to the project repository, rather than relying on later memory.
3. **Preserve verbatim text when the original messages are available.** Never silently rewrite, summarize, or reconstruct a transcript and label it verbatim.
4. Keep separate artifacts:
   - `transcripts/`: source-faithful conversation messages or raw exports.
   - `session-logs/`: concise decision/action summaries, clearly labelled as summaries.
   - `decisions/`: durable requirements, accepted decisions, and rationale.
5. Include metadata: source application, conversation/session identifier if available, date/time and timezone if known, project/repository, capture method, completeness status, and source artifact checksum where feasible.
6. Use explicit statuses: `COMPLETE`, `PARTIAL`, `EXCERPT`, or `SOURCE_UNAVAILABLE`. A summary is never a transcript.
7. At the end of a work session, commit the captured artifacts to a project branch and report the exact repository path, commit/PR URL, and any uncaptured portions. Do not merge or change application code merely to archive conversation records unless separately authorized.
8. For other applications (including coding agents), capture their records through supported exports, APIs, or accessible session logs. Do not claim coverage of an app whose records were not retrieved.
9. Keep a per-project index/register listing sessions found, sessions archived, and known gaps. Never claim the archive is complete until coverage has been checked against the available source inventory.

## Important technical limitation

A normal ChatGPT conversation does not provide this assistant with a universal event hook or background permission to observe and export every other ChatGPT thread or every external application's sessions. Therefore this document alone does **not** create true automatic real-time synchronization.

Until an authorized integration is implemented and tested, synchronization can only occur when the relevant conversation content is available in the active session and repository tools are used. Historical ChatGPT conversations require an account data export or another source that contains their original messages. External apps require their own exports or accessible records.

## Acceptance criteria for a future automatic sync implementation

- A supported event or export source captures every in-scope message with stable conversation and message IDs.
- A project-routing registry maps each project to its exact repository.
- New messages are appended idempotently, preserving original order and source text.
- Retries, pagination, rate limits, edits, deletions, and partial failures are handled and recorded.
- Credentials use least privilege; secrets and unrelated/private conversations are excluded.
- A visible sync status shows last successful capture, lag, errors, and missing ranges.
- Tests prove no duplicate messages, no cross-project leakage, and no false `COMPLETE` status.
- A failed sync raises a visible error; it must never silently pretend to be real-time.
- The feature is enabled only after end-to-end tests verify the actual source integrations. No automatic sync should be claimed before this point.

## Session-close checklist

- [ ] Correct project/repository confirmed.
- [ ] Conversation record saved, or source-access limitation recorded.
- [ ] Decisions and open questions captured separately from verbatim transcript.
- [ ] Completeness status and gaps updated.
- [ ] Commit/PR and verification evidence reported.


## Batch-capture operating model (clarification, 2026-10-22)

The desired behavior is **periodic chunk capture**, not a GitHub commit for every individual message. Capture a coherent batch after a meaningful exchange or at a practical interval, preserving message order and distinguishing verbatim transcript from summary/decisions.

Implementation requirements:
- Buffer/collect all new in-scope messages since the last successful checkpoint, when a supported source makes them available.
- Commit each batch atomically where possible, with a checkpoint/cursor so retries neither lose nor duplicate messages.
- Record batch start/end message IDs and timestamps, last successful sync, lag, and any gap/error.
- A scheduler alone is insufficient: it must have an authorized, supported way to read the conversation messages. Do not fabricate access to ChatGPT thread history or imply a scheduled task can see messages that its source does not expose.
- ChatGPT's built-in recurring task scheduler currently supports daily, weekly, and monthly recurrence, not every few minutes. A shorter cadence would require a separately implemented scheduler (for example, a GitHub Actions cron workflow) **and** a supported conversation-data source. GitHub Actions cannot retrieve private ChatGPT conversation content merely because it runs on a schedule.
- Until the source and scheduled end-to-end path are implemented and tested, perform batch captures of accessible conversation content through available GitHub tools and mark coverage PARTIAL.
