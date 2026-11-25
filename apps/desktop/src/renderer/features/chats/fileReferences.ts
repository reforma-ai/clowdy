import { absolutePath } from '../openWith';
import { type Place, placePath } from '../sidePanel/currentPlace';

import type { FileEntry } from '@clowdy/file-manager';
import type { ClipboardFile } from '../../../shared/bridge';

/** A drag of project paths from the file tree, distinct from files dragged in from the OS. */
export const FILE_REFERENCE_DRAG_TYPE = 'application/x-clowdy-file-references';

export function fileReferences(place: Place, entries: readonly FileEntry[]): ClipboardFile[] {
    return entries.map(({ path, kind }) => ({
        path: absolutePath(placePath(place), path),
        name: path.slice(path.lastIndexOf('/') + 1),
        kind,
    }));
}

/** Read references only on drop, when the browser lets a target access the drag data. */
export function droppedFileReferences(transfer: DataTransfer): ClipboardFile[] {
    try {
        const data: unknown = JSON.parse(transfer.getData(FILE_REFERENCE_DRAG_TYPE));

        if (!Array.isArray(data)) return [];

        return data.filter(
            (entry): entry is ClipboardFile =>
                entry !== null &&
                typeof entry === 'object' &&
                typeof entry.path === 'string' &&
                typeof entry.name === 'string' &&
                (entry.kind === 'file' || entry.kind === 'directory')
        );
    } catch {
        return [];
    }
}
