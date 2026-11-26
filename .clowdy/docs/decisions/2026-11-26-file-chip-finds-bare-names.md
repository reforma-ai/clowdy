# File chips find files named without their folder

- Status: accepted
- Date: 2026-11-26
- Decided by: user (semi-manual), orchestrator (the rules)
- Scope: the file and folder chips in messages (`FileChip`): what a press and the menu do for a path that is not at the written place. Not the quick search, and not folders.
- Related tasks: none
- Supersedes: none
- Superseded by: none

## Context

An agent often writes a file by its name alone (`FileChip.tsx`) or by a tail of its path. The chip read that as a path from the project folder, found nothing there and said "This file doesn't exist", though the quick search (Cmd+K) found the file. The same menu also left a chip for a full path outside every folder of the project with only Copy path, though the file is there to show in the file manager.

## Decisions

1. **A file that is not at the written path is looked for in the project.** It uses the daemon's search of the project's files, the one behind Cmd+K and `@` (git's tracked and unignored files, the worktree's when the chat has one). A file counts when its path ends with the written one by whole names of folders, case aside, in the folder of the chat's place. Only files are looked for, not folders, and only where the Files tab can show them.
2. **One match opens on a press.** The chip opens that file as if it had been written in full. Its right-click menu is the menu of any file, with the real path to copy.
3. **Several matches are listed to choose from.** Options were: the list / open the best one / open only when there is one. Chosen by the user: the list. A press opens a menu of up to ten paths, best first, and pressing a row opens that file in the Files tab. No file is opened that a person did not pick.
4. **No match keeps the old menu.** "This file doesn't exist", with the copies of the path. While the search is out the header says "Looking for this file".
5. **A full path outside the project offers `Open in…`.** The editor and the file manager (Show in Finder for a file), the terminal program for a folder, as everywhere. A path that climbs out of the folder with `..` keeps only Copy path.

## Decided by the agent

- The match is on the end of the path, not on the name alone, so `markdown/FileChip.tsx` does not match `x/other/FileChip.tsx`.
- The search runs on a press or when the menu opens, never when the message is drawn, so a message with many chips costs nothing.

## Consequences

The search answers with at most 100 paths, so for a very common name in a large project the right file may be among those left out. A file that git ignores is not found by a chip (the palette also reads the tree for those). A path whose folder the window is not on is not looked for.
