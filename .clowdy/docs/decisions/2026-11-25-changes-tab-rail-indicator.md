# Show the stage of the work in the Changes tab icon and uncommitted files as a dot

- Status: accepted
- Date: 2026-11-25
- Decided by: user (semi-manual)
- Scope: The Changes item of the side panel's rail (`SidePanelRail`). Not the other tabs, and not the chat list indicators.
- Related tasks: none
- Supersedes: none
- Superseded by: none

## Context
The rail is on screen while the panel is shut or shows another tab, so a change in the Changes tab is invisible until it is opened. The chat list already marks a row with a small colored dot (`StatusDot`, `features/agents/ChatIcon.tsx`). With agents at work a branch almost always has uncommitted files or commits that are not landed, so a dot for every such state would burn all the time and stop meaning anything. The git facts the rail needs (`status.entries`, `base.ahead`, the pull request with its checks and mergeability) already exist in `features/changes/gitFacts.ts`.

## Options considered
1. A colored dot per state (red, yellow, green, a ring for committed work). For: reuses the chat dot. Against: nearly always lit, so it says little.
2. Dynamic icon per stage, with a colour per stage. For: the stage reads as a calm status. Against: colour carries the meaning, which the user did not want.
3. Dynamic icon per stage with no colour change, plus one dot only for uncommitted files. For: the dot stays an alert for the one thing that needs a person, the shape says where the branch is. Against: the existing Version and Merge glyphs are mirror images at 14px.

## Decision
Option 3. The icon is `Commit` when nothing waits, `Version` (branch) when commits are not in the base and no pull request is open, `Merge` while a pull request is open or a draft, and `VersionWarn` for a merge with conflicts, a paused rebase, failing checks, requested changes or a pull request that conflicts with its base. A yellow dot sits on the tile while files are uncommitted and the tab is not on show. The tooltip adds the reason and the file count under the label. A merged pull request counts as landed even before the base is fetched.

## Reason
- Fit: the dot is `StatusDot` with the `warning` tone, as on a chat's icon; the facts come from the shared git facts store, so the rail and the tab are one reader.
- Reversibility: one pure function (`changesSummary`) and one optional `dot` prop on `RailItem`; removing the wiring in `SidePanelRail` restores the plain tab.
- Cost: the rail now keeps the place's git facts read while a project is on show, including the `gh` pull request lookup, even when the Changes tab was never opened.

## Consequences
A dedicated pull request glyph would tell the `Merge` stage from the `Version` stage more clearly; icons are drawn in Figma and synced, so it is a design task. Reopen if the extra reads cost too much or the icons are hard to tell apart in use.
