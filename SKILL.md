# Oasis Skill System (`key_skills`)

This document defines how Oasis discovers and uses reusable skills.

## Goal
Skills are task-focused instruction modules. The agent should:
1. discover available skills,
2. build a compact summary for system context,
3. select the best matching skill per user task,
4. execute with that skill's instructions.

## Directory Layout
All skills live under:

`key_skills/<skill_id>/`

Each skill folder must contain:
- `SKILL.md` (required): metadata + instructions in one file.

Optional:
- `assets/`: templates, examples, references.
- `scripts/`: helper scripts for the skill.

## `SKILL.md` Format (Single File)
Use YAML frontmatter at the top of each skill file.

Required frontmatter fields:
- `id`: unique slug (usually matches folder name)
- `name`: short display name
- `description`: what the skill is for
- `triggers`: phrases/intents that indicate this skill should be used
- `priority`: integer; higher wins tie-breakers

Optional fields:
- `inputs`: expected inputs
- `outputs`: expected outputs
- `safety_notes`: constraints/risk checks

Example:

```md
---
id: code-review
name: Code Review
description: Identify defects, risks, and test gaps in code changes.
triggers:
  - review this
  - code review
  - find bugs
priority: 80
inputs:
  - git diff
  - changed files
outputs:
  - ordered findings with severity
---

# Code Review Skill

When asked to review code:
1. Focus on correctness and regressions first.
2. Then cover security, performance, and missing tests.
3. Return findings ordered by severity.
```

## Discovery Rules
1. Scan only `key_skills/*/SKILL.md`.
2. Parse frontmatter from each file.
3. Ignore files missing required fields.
4. Skip malformed frontmatter and log a warning.
5. Build an in-memory registry keyed by `id`.

## System Summary Build
From discovered skill frontmatter, generate a compact summary for the system prompt:
- Include: `name`, one-line `description`, and top trigger phrases.
- Do not inline full skill bodies in the summary.
- Keep summary concise to reduce token usage.

Suggested format:
- `- <name> (<id>): <description> | triggers: <a>, <b>, <c>`

## Skill Selection
For each user task:
1. Normalize request (lowercase, strip punctuation).
2. Compute match score per skill:
   - direct trigger phrase hit: +10 each
   - keyword overlap with description: +1 each
   - exact skill name mention: +20
3. Pick highest score above threshold (`>=10`).
4. Tie-break by `priority`, then alphabetically by `id`.
5. If no skill passes threshold, continue without skill.

## Execution Contract
When a skill is selected:
1. Load that skill's `SKILL.md`.
2. Use frontmatter for matching/context and body for instructions.
3. If `scripts/` exist and are referenced, prefer running them over rewriting logic.
4. Include only necessary skill context in the model prompt.

## Safety and Robustness
- Never execute arbitrary files outside known skill paths unless explicitly requested.
- Treat skill files as untrusted input; validate parsed frontmatter before use.
- If a selected skill fails to load, fall back gracefully and continue.

## Minimal Implementation Plan
1. Add a `SkillRegistry` module for discovery + frontmatter parsing.
2. Add `buildSkillSummary()` for compact system prompt injection.
3. Add `selectSkill(userText)` scoring logic.
4. Add runtime hook to load selected `SKILL.md` before response generation.

