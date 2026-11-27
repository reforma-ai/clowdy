import { FileDropOverlay } from '@clowdy/components/FileDropOverlay';
import { useFileDrag, useFilePaste } from '@clowdy/components/hooks';
import { type DragEvent, type ReactNode, useState } from 'react';

import styles from './ChatDropZone.module.css';
import { mentionFilesIntoComposer, mentionTasksIntoComposer, useCanMentionFiles } from './composerBridge';
import { droppedFileReferences, FILE_REFERENCE_DRAG_TYPE } from './fileReferences';
import { droppedTaskReference, TASK_REFERENCE_DRAG_TYPE } from './taskReferences';

export interface ChatDropZoneProps {
    /** Files dropped on the zone, and pasted into it when `onPasteFiles` is not given. */
    onFiles: (files: readonly File[]) => void;
    /** Files pasted into the zone, which may be somewhere else than the page's disk: the clipboard says where they came from. */
    onPasteFiles?: (files: readonly File[]) => void;
    /** The page has no message box (a read-only chat): no veil, and nothing is taken. */
    disabled?: boolean;
    children: ReactNode;
}

/** The whole chat page takes files: while some are dragged over it, a veil says where they go; a paste of files lands here too. */
export function ChatDropZone({ onFiles, onPasteFiles = onFiles, disabled = false, children }: ChatDropZoneProps) {
    const [over, setOver] = useState(false);
    const canMentionFiles = useCanMentionFiles();

    // A veil that was up when the zone was switched off must not come back with it: the drag it belonged to is over for this zone.
    if (disabled && over) setOver(false);

    const drag = useFileDrag({ enabled: !disabled, onFileDragOver: setOver, onFilesDropped: onFiles });
    const paste = useFilePaste({ enabled: !disabled, onFilesPasted: onPasteFiles });
    const isReferenceDrag = (event: DragEvent) =>
        !disabled &&
        canMentionFiles &&
        (event.dataTransfer.types.includes(FILE_REFERENCE_DRAG_TYPE) ||
            event.dataTransfer.types.includes(TASK_REFERENCE_DRAG_TYPE));

    // Capture before the rich text input handles drops of its own content.
    const referenceDragOver = (event: DragEvent) => {
        if (!isReferenceDrag(event)) return;

        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
    };

    return (
        <div
            className={styles.zone}
            onDragEnterCapture={referenceDragOver}
            onDragOverCapture={referenceDragOver}
            onDropCapture={event => {
                if (!isReferenceDrag(event)) return;

                event.preventDefault();
                event.stopPropagation();
                setOver(false);
                const point = { x: event.clientX, y: event.clientY };
                if (event.dataTransfer.types.includes(FILE_REFERENCE_DRAG_TYPE)) {
                    mentionFilesIntoComposer(droppedFileReferences(event.dataTransfer), point);
                } else {
                    mentionTasksIntoComposer(droppedTaskReference(event.dataTransfer), point);
                }
            }}
            onDragEnter={drag.onDragEnter}
            onDragLeave={drag.onDragLeave}
            onDragOver={drag.onDragOver}
            onDrop={drag.onDrop}
            onPaste={paste.onPaste}
        >
            {children}
            <FileDropOverlay open={over} label="Drop files to attach them to the message" />
        </div>
    );
}
