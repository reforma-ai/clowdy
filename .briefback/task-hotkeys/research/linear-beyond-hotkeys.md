# Linear task-workflow strengths beyond hotkeys (seed list for a later roadmap)

Researched 2026-11-17. One line per item, seeded from current Linear docs and changelog. This is a pointer list, not a design. "Clowdy angle" marks how an item might touch a task list with statuses, linked chats/runs and dependencies; that column is my inference, not Linear's claim.

## Summary

Linear's task workflow is strong in five places that go beyond the keyboard: **intake** (Triage, Asks, templates), **a small fixed issue model with rich relations** (status categories, priority, sub-issues, blocked/blocking), **views** (filters, grouping, ordering, saved views, board, peek), **a personal queue** (My Issues, Inbox, snooze/reminders), and **agents** (delegation, coding-tool handoff, Loops). For a product where tasks link to AI chats and runs, the agent-handoff and "copy as prompt" items are the closest analogue of Clowdy's differentiator.

## Intake and triage

- **Triage queue**: a per-team inbox for issues that arrive from integrations or other teams, with Accept (`1`), Decline (`2`), Duplicate (`3`), Snooze (`H`) before they enter the workflow. [docs/triage; changelog 2026-07-30]
- **Triage rules and responsibility**: route, label or assign incoming issues by condition; rotate who watches the queue. [docs/triage, assigning-issues]
- **Triage Intelligence / Product Intelligence**: AI suggestions for team, labels, assignee and duplicates that a human accepts or dismisses. [docs/triage-intelligence; changelog 2025-08-14, 2025-09-18]
- **Linear Asks**: turn Slack, email and web-form requests into issues with the requester attached. [docs/linear-asks]
- **Issue templates and "create from template" (Opt/Alt+C)**: pre-fill properties, placeholder text, default template per team, workspace versus team scope. [docs/issue-templates]
- **Issue drafts**: unfinished issue survives navigation (local) and Esc offers a persistent draft (synced, six months). [docs/creating-issues; changelog 2023-05-11]
- **Create via URL / `linear.new`** with pre-filled query parameters (title, status, assignee, estimate, labels, template). [docs/creating-issues]
- **Recurring issues** on a cadence, created when the due date passes. [docs/creating-issues]

## Issue model

- **Status categories** (backlog, unstarted, started, completed, canceled, plus reserved Duplicate) with team-defined statuses inside each category; auto-close and auto-archive. [docs/issue-property "Issue status"]
- **Priority fixed at five levels** (none, low, medium, high, urgent), deliberately not customisable; extra nuance goes into statuses or labels. [docs/issue-property "Priority"]
- **Labels with groups** (single or multi-select groups since 2026-10-22), label descriptions on hover, bulk label management. [docs/issue-property; changelog 2026-10-22, 2025-10-09]
- **Estimates and due dates**, optional per team; SLAs on Business plans. [docs/issue-property]
- **Relations**: related, blocked by, blocking, duplicate; duplicate moves the issue to the reserved status; blocked flags in the sidebar. [docs/issue-property "Issue relations"] Clowdy angle: maps onto task dependencies.
- **Parent and sub-issues**: create from the menu, paste a list to create many, convert comment or checklist to sub-issues, set parent in bulk. [docs/parent-and-sub-issues]
- **Time in status**: see how long an issue sat in each status; order or filter by it. [changelog 2026-01-29]
- **Issue activity log with a three-minute creation grace window** so initial edits are not logged as changes. [docs/creating-issues]
- **Git branch naming copy action** that can auto-assign and move the issue to a started status. [docs/assigning-issues; changelog 2020-04-14]

## Views and list ergonomics

- **Filters**: quick `F` filter bar, advanced AND/OR groups, natural-language "Filter with AI", filters mirrored in the URL. [docs/filters]
- **Display options**: grouping, ordering (including Manual for drag or keyboard reorder), sub-grouping into swimlanes, visible properties, saved as personal or workspace default. [docs/display-options, board-layout]
- **Custom views**: save any filtered list (Opt/Alt+V), share, favorite, subscribe to a view. [docs/custom-views]
- **List and board layouts** with the same shortcuts; swimlane rows. [docs/board-layout]
- **Peek** (Space) previews the hovered issue without leaving the list. [docs/board-layout]
- **My Issues** with a curated focus order (urgent, blockers, cycle work, backlog) and four tabs: assigned, created, subscribed, activity. [docs/my-issues]
- **Favorites and sidebar customisation**, folders, personalised sidebar. [docs/favorites; changelog 2024-12-18]
- **Search** across title, description and comments, with prefix scoping and `@` filters, plus 500-result cap and relevance ordering by status. [docs/search; changelog 2025-04-10]
- **Cycles**: time-boxed sprints with auto-created upcoming cycles, cooldowns, rollover and a progress graph. [docs/use-cycles]
- **Projects, milestones, initiatives and updates** for larger scope above issues. [docs/projects, initiatives]

## Personal queue and notifications

- **Inbox** with keyboard triage: read/unread, snooze, delete, archive, filter by notification type, quick search. [docs/inbox]
- **Snooze and reminders on issues and documents** (`H`). [docs/inbox; changelog 2025-03-06]
- **Subscriptions** (auto-subscribe on assign, mention, create) managed in bulk. [docs/my-issues, notifications]
- **Notification digests and channels** (desktop, Slack, email, mobile). [docs/notifications]

## Agents and automation

- **Delegate an issue to an agent while a human stays assignee** (including third-party agents such as Cursor, Codex, GitHub Copilot). [docs/assigning-issues; changelog 2025-08-21, 2025-10-28, 2025-12-04] Clowdy angle: closest analogue of "task linked to a chat or run".
- **Open an issue in a coding tool** (Claude Code, Codex, Cursor, custom scripts) with a prompt template, `W` then `O` or Cmd+Opt+`.`. [docs/assigning-issues; changelog 2026-02-26, 2026-04-02, 2026-04-16]
- **Copy issue as Markdown / "Copy as prompt"** for pasting into AI chat. [changelog 2025-02-13, 2026-05-28]
- **Linear Agent** chat (Cmd/Ctrl+J) and `@Linear` in comments; **Loops** run agent workflows on a schedule or on events (new triage issue, cycle end). [docs/linear-agent, loops]
- **Linear cloud coding agent** sessions, diffs and reviews, BYOK for model providers (2026-11-12). [docs/linear-cloud-coding-agent, diffs; changelog 2026-11-12]
- **MCP server and connectors** for external tools. [docs/mcp, connect-mcp-servers]
- **Slack and GitHub integrations**: PR linking updates statuses automatically; Slack unfurls and global create shortcut. [docs/github-integration, slack]

## Insights and customer context

- **Insights and dashboards** over issue data (cycle time, time in status). [docs/insights, dashboards]
- **Customer Requests** attach customer demand to issues and projects. [docs/customer-requests]
- **Pulse** feed of updates across the product org. [docs/pulse]

## Sources (accessed 2026-11-17)

All under `https://linear.app/docs/<slug>.md` unless noted: triage, triage-intelligence, linear-asks, issue-templates, creating-issues, issue-property (served at `/docs/issue-property`), parent-and-sub-issues, assigning-issues, filters, display-options, custom-views, board-layout, my-issues, favorites, search, use-cycles, projects, initiatives, inbox, notifications, linear-agent, loops, linear-cloud-coding-agent, diffs, mcp, connect-mcp-servers, github-integration, slack, insights, dashboards, customer-requests, pulse. Docs: index at https://linear.app/llms.txt and sitemap https://linear.app/sitemap.xml. Changelog entries (dates inline): https://linear.app/changelog and its numbered pages.

## Open questions

1. Which of these map to Clowdy's actual task model (statuses, linked chats and runs, dependencies) is for the parent synthesis, not for this page.
2. Linear plan gating (Business or Enterprise: SLAs, Insights, triage rules, issue sharing) was noted only where the docs say so.

## Assumptions and limits

- Pages were read as text; I did not use the app. Plan tiers and 2026 AI features (Loops, cloud coding agent) change quickly; treat them as a 2026-11-17 snapshot.
- Items are summarised in one line each; behaviour details beyond the keyboard were not verified in the product.
