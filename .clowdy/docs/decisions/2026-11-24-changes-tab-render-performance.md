# Cut needless renders in the Changes tab and render far cards as placeholders

- Status: accepted
- Date: 2026-11-24
- Decided by: user (semi-manual)
- Scope: The Changes tab of the side panel: the diff list, its cards and the commit box
- Related tasks: CLO-128, CLO-129, CLO-130
- Supersedes: none
- Superseded by: none

## Context

The person felt the whole app slow down while the Changes tab was open, even with every diff folded. A render-count probe with 200 changed files first pointed at four needless render paths. Measured again with the renderer's observer plugin (which the unit tests do not load), two of them were cheap: a Shift press and a keystroke in the commit message re-render the commit box but not its file list. Two were real: every round of git reads (window focus, end of a run) re-rendered every card even when nothing changed, and ticking Viewed on one card re-rendered every card. Every card is also mounted at once, so a list of hundreds of files is slow to open.

## Options considered

1. Targeted fixes for the four render paths only.
2. Targeted fixes, plus rendering only the cards near the screen.
3. Change nothing for now.

## Decision

Do both: fix the render paths so that an event re-renders only what it changes, and keep only the cards near the screen fully built, with the others as light placeholders of their estimated height. Scrolling, the sticky card headers and the jump to a file from the last run summary keep working as before.

## Reason

The render paths explain the slowdown during everyday work. Large lists also cost time and memory on opening.

## Consequences

The visible behaviour of the tab stays the same. The cards far from the screen hold no controls until they come near. A regression test counts the renders of these events.
