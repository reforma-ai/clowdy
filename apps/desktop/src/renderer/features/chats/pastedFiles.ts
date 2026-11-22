import { pathInside } from '../files/systemClipboard';

import type { ComposerMentionAttrs } from '@clowdy/components/RichInput';
import type { ProjectFolder } from '@clowdy/protocol';
import type { ClipboardFile } from '../../../shared/bridge';

/**
 * The chips for the files and folders on the clipboard that are inside the project's folders, in the order they were copied. They are cited by their path, as a
 * file picked after `@` is (`fileItems`): the main folder's from that folder, since the agent works in it, another folder's by its absolute path. A file that is
 * somewhere else is left for the message to carry as an attachment.
 */
export function mentionedFiles(clipboard: readonly ClipboardFile[], folders: readonly ProjectFolder[]): ComposerMentionAttrs[] {
    return clipboard.flatMap((file): ComposerMentionAttrs[] => {
        for (const [index, folder] of folders.entries()) {
            const relative = pathInside(folder.path, file.path);

            if (relative !== undefined) {
                return [{ id: `file:${ folder.id }:${ relative }`, label: file.name, kind: 'file', trigger: '@', data: { path: index === 0 ? relative : file.path } }];
            }
        }

        return [];
    });
}

/** What the page can do with files that were pasted into the message box. */
export interface PasteTargets {
    folders: readonly ProjectFolder[];
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
export async function pasteFiles(files: readonly File[], { folders, mention, attach }: PasteTargets): Promise<void> {
    let held: ClipboardFile[] = [];

    try {
        held = (await window.desktop?.readClipboardFiles?.()) ?? [];
    }
    catch {
        // The clipboard cannot be read: the files go up as they are.
    }

    const chips = mentionedFiles(held, folders);
    // The browser names a pasted file or folder by its name only.
    const mentioned = new Set(held.filter(file => chips.some(chip => chip.label === file.name)).map(file => file.name));
    const rest = files.filter(file => !mentioned.has(file.name));

    for (const chip of chips) mention(chip);

    if (rest.length > 0) attach(rest);
}
