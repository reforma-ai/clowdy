import { MAX_BASE_BRANCH_LENGTH, MAX_SETUP_COMMAND_LENGTH, MAX_SETUP_FILES } from '@clowdy/protocol';

import { invalid } from '../errors';

import type { FolderSettings, WorkspaceSetup } from '@clowdy/protocol';

/** What `project.updateFolder` changes: a field that is left out stays, one set to `null` is cleared, and `setup` is replaced whole. */
export interface FolderSettingsPatch {
    name?: string | null;
    baseBranch?: string | null;
    setup?: WorkspaceSetup | null;
}

/** The longest entry of `WorkspaceSetup.files`, in characters. */
const MAX_SETUP_FILE_LENGTH = 500;

/** A control character (NUL, a newline, DEL, the C1 ones), a line or paragraph separator, or a mark that turns the text's direction: nothing a file or a branch is named with. */
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/u;

/**
 * Why a `WorkspaceSetup.files` entry is not one, or nothing when it is. The entries are written in a portable notation, so `/` is their separator on every system, and
 * they are checked as written, before any system's rules for paths apply: a path that is relative on one system (`C:foo`, `\server\share`, `a\..\b`) is not on another.
 * A name `.git` is refused wherever it stands (case and a trailing dot or space do not hide it from Windows): in a linked worktree it is a file that points at the
 * repository, not something to copy.
 */
function setupFileProblem(file: string): string | undefined {
    if (file.length > MAX_SETUP_FILE_LENGTH) return `is longer than ${MAX_SETUP_FILE_LENGTH} characters`;

    if (UNPRINTABLE.test(file)) return 'has a control character';

    if (file.includes('\\')) return 'must be written with /, not \\';

    // A drive (`C:`) or, on NTFS, a stream (`.env:stream`).
    if (file.includes(':')) return 'must not have a : in it';

    if (file.startsWith('/')) return 'must be relative to the folder';

    const parts = file.split('/');

    if (parts.includes('')) return 'has an empty part';

    // `.`, `..`, and what Windows reads as one of them (`.. `, `...`): the entry would leave the folder or name the folder itself.
    if (parts.some(part => /^[. ]+$/.test(part))) return 'must not have a . or .. part';

    if (parts.some(part => part.replace(/[. ]+$/, '').toLowerCase() === '.git')) return 'must not name .git';

    if (parts.slice(0, -1).some(part => part.includes('*'))) return 'may have a * only in its last part';

    return undefined;
}

/**
 * The setup as it is kept: files trimmed, checked and listed once, the command trimmed; `undefined` for a setup that has neither (no setup at all). The limits are
 * checked here, on the text as it is kept, so a refusal says which limit it is.
 */
function cleanSetup(setup: WorkspaceSetup): WorkspaceSetup | undefined {
    const files: string[] = [];

    for (const entry of setup.files) {
        const file = entry.trim();
        const problem = file === '' ? 'is empty' : setupFileProblem(file);

        if (problem) throw invalid(`The file ${JSON.stringify(entry)} ${problem}`);

        if (!files.includes(file)) files.push(file);
    }

    if (files.length > MAX_SETUP_FILES) throw invalid(`A setup lists at most ${MAX_SETUP_FILES} files`);

    const command = setup.command?.trim();

    if (command && command.length > MAX_SETUP_COMMAND_LENGTH)
        throw invalid(`The command is longer than ${MAX_SETUP_COMMAND_LENGTH} characters`);

    // A script is text with newlines in it, but a NUL ends the argument a shell is started with: the step would fail on every try.
    if (command?.includes('\0')) throw invalid('The command has a NUL character');

    return files.length > 0 || command ? { files, ...(command && { command }) } : undefined;
}

function cleanBaseBranch(name: string): string {
    const branch = name.trim();

    if (!branch) throw invalid('The base branch is empty');

    if (branch.length > MAX_BASE_BRANCH_LENGTH)
        throw invalid(`The base branch is longer than ${MAX_BASE_BRANCH_LENGTH} characters`);

    if (UNPRINTABLE.test(branch)) throw invalid('The base branch has a control character');

    // No branch is named so, and a name that starts with `-` would be an option wherever it is handed to git.
    if (branch.startsWith('-')) throw invalid('The base branch cannot start with -');

    return branch;
}

/** The settings after `patch`, checked: `invalid` for a branch or a setup the daemon refuses. Nothing (not an empty object) when no field is left. */
export function mergeFolderSettings(
    current: FolderSettings | undefined,
    patch: FolderSettingsPatch
): FolderSettings | undefined {
    const merged: FolderSettings = { ...current };

    if (patch.name === null) {
        delete merged.name;
    } else if (patch.name !== undefined) {
        const name = patch.name.trim();

        if (!name || name === '.' || name === '..' || name.length > 100 || UNPRINTABLE.test(name) || /[\\/]/.test(name))
            throw invalid('The folder name must be 1 to 100 characters without slashes or control characters');

        merged.name = name;
    }

    if (patch.baseBranch === null) {
        delete merged.baseBranch;
    } else if (patch.baseBranch !== undefined) {
        merged.baseBranch = cleanBaseBranch(patch.baseBranch);
    }

    if (patch.setup !== undefined) {
        const setup = patch.setup === null ? undefined : cleanSetup(patch.setup);

        if (setup) {
            merged.setup = setup;
        } else {
            delete merged.setup;
        }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
}
