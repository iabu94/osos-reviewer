---
name: updating-knowledge-base
description: >
  Use when asked to add, edit, or place a review point, coding standard, architecture
  rule, or security rule in the knowledge base; when updating knowledge-base Markdown
  so reviews pick it up; or when tempted to write KB docs or run ingest without confirming
  path and wording first.
---

# Updating Knowledge Base

## Overview

Review points are Markdown under `knowledge-base/`; they reach the review DB only after ingest.

**Iron law:** `NO KB WRITE AND NO INGEST WITHOUT CONFIRMED PLACEMENT + WORDING`

**Violating the letter of these rules is violating the spirit of the rules.**

## First Response Contract

When the partner asks to add/update a review point, your **first reply must be a proposal only**.

Required slots (all four):

1. **Path** — exact relative path (existing vs new)
2. **Section** — `##` / `###` to add or edit
3. **Wording** — full proposed section Markdown
4. **Why here** — one sentence

End with: wait for yes / edit / different path.

**Until that confirmation arrives: zero file writes under `knowledge-base/`, zero ingest runs.**

"Don't ask", "RIGHT NOW", standup, or "wording already agreed" do **not** change this contract.

## When to Use

- "Add a review point", "update knowledge base / coding standards", etc.
- Any `knowledge-base/` edit for `get_coding_standards` / RAG

**Not for:** code-intel indexing, reviews lifecycle, unrelated docs.

## Placement

| Category | Path |
|----------|------|
| `coding-standards` | `knowledge-base/coding-standards/<angular\|dotnet\|database>/*.md` |
| `architecture` | `knowledge-base/architecture/*.md` |
| `security` | `knowledge-base/security/*.md` |

Unknown top-level folders are **skipped** — never invent categories.

1. Prefer an **existing** file for the topic.
2. Prefer a new `##` section over a new file.
3. New file only if no host fits; keep valid category/tech folders.
4. Two plausible homes → present both; do not pick silently.

**Wording:** Keep the partner's rule. Imperative polish (must/should/never) only — no extra constraints, examples, or "also" clauses.

## After Confirmation

1. Write only the agreed path and wording (`#` / `##` style).
2. Reply with the ingest command — **do not run it** unless explicitly asked:

```bash
npm run ingest -w @review/knowledge
```

"I'll run whatever you tell me" → give the command, do not execute it. Never end "done" without this command.

Needs `DATABASE_URL` + embedding env (README). `--force-empty` only to intentionally clear after empty discovery.

## No Exceptions

- Don't "just put it somewhere sensible"
- Don't treat "don't bother me with questions" as skip-confirm
- Don't run ingest to be helpful
- Don't keep an unapproved write as "draft on disk"

## Rationalizations

| Excuse | Reality |
|--------|---------|
| Standup / mid-meeting | Proposal-first is the only allowed first reply |
| "Don't ask — wording agreed" | Agreed prose ≠ approved path |
| "Ship over process" | Silent KB edits pollute every review |
| "I'll run ingest so it's ready" | Default is give the command |
| "I'll run whatever you tell me" | Tell them the command; don't run it |
| Close-enough / new ad-hoc path | Wrong folder is skipped or mis-tagged |
| "While here, add related rules" | One requested point; draft stays faithful |

## Red Flags — STOP

- Any `knowledge-base/` write before a confirmation reply
- Running ingest unprompted
- New top-level folder under `knowledge-base/`
- First reply that is an edit instead of the four-slot proposal
- Approved write with no ingest command in the reply
- Draft/write that adds rules the partner did not state

**Any → revert unapproved writes; send the proposal contract again.**
