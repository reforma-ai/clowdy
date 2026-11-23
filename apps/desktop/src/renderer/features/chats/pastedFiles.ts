import { pathInside } from '../files/systemClipboard';
import { type Place, placePath } from '../sidePanel/currentPlace';

import type { ComposerMentionAttrs } from '@clowdy/components/RichInput';
import type { ProjectFolder } from '@clowdy/protocol';
import type { ClipboardFile } from '../../../shared/bridge';

/**
 * The chips for the files and folders on the clipboard that are inside the place the message is written in, or inside the project's folders, in the order they were copied.
 * They are cited by their path, as a file picked after `@` is (`fileItems`): one inside the place (the worktree of a chat that works in one, else the folder it works in, the
 * main one when no `place` is given) from there, since the agent works in it; another folder's by its absolute path. A file that is somewhere else is left for the message
 * to carry as an attachment.
 */
export function mentionedFiles(
    clipboard: readonly ClipboardFile[],
    folders: readonly ProjectFolder[],
    place?: Place
): ComposerMentionAttrs[] {
    const home = place?.folder ?? folders[0];
    const root = place ? placePath(place) : home?.path;
    const chip = (file: ClipboardFile, id: string, path: string): ComposerMentionAttrs[] => [
        {
            id,
            label: file.name,
            kind: 'file',
            trigger: '@',
            data: { path, ...(file.kind === 'directory' && { directory: true }) },
        },
    ];

    return clipboard.flatMap((file): ComposerMentionAttrs[] => {
        const here = home && root !== undefined ? pathInside(root, file.path) : undefined;

        // The worktree is not under any folder of the project, so it is asked first.
        if (home && here !== undefined) return chip(file, `file:${home.id}:${here}`, here);

        for (const folder of folders) {
            const relative = pathInside(folder.path, file.path);

            if (relative !== undefined) return chip(file, `file:${folder.id}:${relative}`, file.path);
        }

        return [];
    });
}

/** What the page can do with files that were pasted into the message box. */
export interface PasteTargets {
    folders: readonly ProjectFolder[];
    /** Where the message is written: its paths are from there. The main folder when absent. */
    place?: Place;
    /** Puts a chip in the message, where the caret is. */
    mention: (mention: ComposerMentionAttrs) => void;
    /** Attaches files to the message, to be uploaded. */
    attach: (files: readonly File[]) => void;
}

/**
 * Takes files pasted into the message box. The clipboard of the desktop app says where each of them is on the disk: a file that is inside the project's folders (copied
 * in the Files tree, or in Finder or Explorer) is already there for the agent to read, so it becomes a chip with its path and is not uploaded. The rest, and every
 * file in a page that is not the desktop app, are attached, as the browser gives them.
 */
export async function pasteFiles(
    files: readonly File[],
    { folders, place, mention, attach }: PasteTargets
): Promise<void> {
    let held: ClipboardFile[] = [];

    try {
        held = (await window.desktop?.readClipboardFiles?.()) ?? [];
    } catch {
        // The clipboard cannot be read: the files go up as they are.
    }

    const chips = mentionedFiles(held, folders, place);
    // The browser names a pasted file or folder by its name only, so each chip takes one pasted file of its name: an outside file of the same name stays to be attached.
    const rest = [...files];

    for (const chip of chips) {
        const index = rest.findIndex(file => file.name === chip.label);

        if (index !== -1) rest.splice(index, 1);
    }

    for (const chip of chips) mention(chip);

    if (rest.length > 0) attach(rest);
}
