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
