---
id: reminder-heartbeat
name: Reminder Heartbeat
description: Configure recurring reminders and a self-heartbeat check-in loop for Oasis.
triggers:
  - set reminder
  - recurring task
  - heartbeat
  - every 30 minutes
  - schedule this
priority: 75
inputs:
  - reminder id
  - prompt
  - interval minutes
outputs:
  - updated scheduler config
  - active recurring reminder behavior
safety_notes:
  - high-stakes actions still require explicit approval
---

# Reminder Heartbeat Skill

Use this skill when a user wants scheduled prompts or heartbeat-style recurring checks.

## Goal
Create recurring reminders that run on the `background` queue without relying on ad-hoc shell timers.

## Preferred Architecture
1. Use the built-in scheduler in runtime code.
2. Keep schedules in `config/config.yaml` under `scheduler`.
3. Route recurring work through `submitTask(..., "background")`.
4. Use shell cron only when the process is not always running.

## Scheduler Config Shape
`scheduler.enabled`: global on/off

`scheduler.tick_seconds`: how often to poll due reminders

`scheduler.reminders[]` fields:
- `id`: stable unique slug
- `enabled`: boolean
- `interval_minutes`: integer
- `lane`: `fast` | `slow` | `background`
- `prompt`: instruction sent to the agent each run

`scheduler.heartbeat` fields:
- `enabled`: boolean
- `interval_minutes`: integer (commonly `30`)
- `prompt`: self-check prompt

## Usage Notes
- For task reminders, add an item in `scheduler.reminders`.
- For periodic self-check, set `scheduler.heartbeat.enabled: true`.
- Runtime command support: `/heartbeat 30`, `/heartbeat 45m`, `/heartbeat 1h`, `/heartbeat off`.
- Keep heartbeat prompts operational: queue health, memory pressure, pending actions, and blockers.
- If the app is down, in-process reminders do not run; use external cron/systemd/launchd only for always-on reliability.
