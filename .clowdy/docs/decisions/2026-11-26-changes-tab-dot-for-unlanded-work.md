# The Changes tab icon follows the pull request, and one dot marks work that is nowhere else

- Status: accepted
- Date: 2026-11-26
- Decided by: user (semi-manual)
- Scope: The Changes item of the side panel's rail (`SidePanelRail`, `RailItem`, `useChangesSummary`, `changesStage`). Not the other tabs, and not the chat list indicators.
- Related tasks: none
- Supersedes: none
- Superseded by: none

## Context
The rail is on screen while the panel is shut or shows another tab, so a change in the Changes tab is invisible until it is opened. Three versions were tried on 2026-11-25 and 2026-11-26 and dropped by the user after seeing them: an icon that changed with four stages (the branch and merge glyphs are mirror images at 14px, and the warning glyph hard-codes its colors), a count with an arrow that repeated the sync button of Source Control (a pill over the corner of the tab, which said more than the rail needs), and a dot that burned whenever anything was uncommitted. With agents at work a branch nearly always has something, so a signal needs a narrower meaning. The record "Archive a merged pull request once the branch has commits of its own since" gives the rule for a merged pull request that the branch has moved past.

## Options considered
1. Keep a count. Against: rejected by the user after seeing it.
2. Icon by the pull request, and one dot for work that exists nowhere else. For: one meaning each, and nothing to read.

## Decision
Option 2.
- **Icon:** the merge icon while Source Control lists a pull request under the sync button (an open or draft one, or the newest merged one the branch has not moved past); the commit icon in every other case.
- **Dot:** small (4px), in the primary colour, on the tab's top right corner, shown while the Changes tab is not the one on show (on another tab, or with the panel shut). It means the branch has files that are uncommitted, or commits that are not merged and are in no pull request (the commits are `base.ahead`, and no pull request holds them under the same rule that draws the merge icon).
- **Tooltip:** under the label and the key, the stage (`Pull request #48 is open, checks are running`, `Checks are failing on #48`, `7 commits not in origin/clowdy/dev`, `Pull request #48 is merged`), the words of the sync button (`2 commits to pull and 1 commit to push`, `17 commits to merge from main`) and `3 uncommitted files`.

## Reason
- Fit: the icon, the dot and the pull request list of Source Control read the same rows (`partitionPullRequests`), so they cannot disagree; the tooltip words come from `syncButton` itself.
- Reversibility: `RailItem` takes one optional `dot`; `useChangesSummary` computes `unlanded`; the icon is one expression in the rail.
- Cost: the rail keeps the place's git facts and the branch's pull request history read while a project is on show, as the chat list already does for its rows.

## Consequences
Commits that are pushed and wait with no pull request keep the dot until a pull request is opened or they are merged. After a squash or rebase merge the dot stays off while the merged pull request is shown. Commits that are not pushed yet on a branch with an open pull request give no dot, as the rule was given. The colour is the primary colour, read from the word "orange", not the amber warning colour; it is one token to change. Reopen if people miss the numbers.
