# Project switch keys

- Status: accepted
- Date: 2026-11-25
- Decided by: user (the keys), orchestrator (the rest)
- Scope: The project menu's order, Settings > Projects, the View menu
- Related tasks: none
- Supersedes: none
- Superseded by: none

## Context

The person switches projects often and wanted keys for it: Cmd+Option and a digit, the personal space on 0 and the others in order. Cmd+Option+0 was already the View menu's Actual size, and the menu takes a key before the page does.

## Decision

- Cmd+Option+0 opens the personal space. Cmd+Option+1 to 9 open the projects in the order of the project menu and of Settings > Projects. The tenth project and later have no key. Off a Mac the keys are Ctrl+Alt and the digit.
- The keys run from a text field, and over Settings alone, where the list shows them. They do not run over a confirmation, a picker or a menu, so the project never changes under what the person is answering. Opening a project this way closes Settings.
- Settings > Projects shows a row's keys before its menu button. The project menu does not show them yet.
- Actual size moves to Cmd+0 (Ctrl+0), the usual key in a browser. The old reason to keep it off Cmd+0, the side panel's Info tab, is gone: the tabs use Cmd+1 to 5.

## Reason

The keys follow the order the person already arranged by dragging. Moving Actual size to its usual key keeps Cmd+Option+0 free for the personal space without dropping the request.

## Consequences

Dragging a project in the list changes its key. Whoever used Cmd+Option+0 for Actual size now uses Cmd+0.
