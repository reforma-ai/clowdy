import { FileDropOverlay } from '@clowdy/components/FileDropOverlay';
import { useFileDrag, useFilePaste } from '@clowdy/components/hooks';
import { type ReactNode, useState } from 'react';

import styles from './ChatDropZone.module.css';

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

    // A veil that was up when the zone was switched off must not come back with it: the drag it belonged to is over for this zone.
    if (disabled && over) setOver(false);

    const drag = useFileDrag({ enabled: !disabled, onFileDragOver: setOver, onFilesDropped: onFiles });
    const paste = useFilePaste({ enabled: !disabled, onFilesPasted: onPasteFiles });

    return (
        <div
            className={styles.zone}
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
