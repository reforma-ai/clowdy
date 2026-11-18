import { FileDropOverlay } from '@clowdy/components/FileDropOverlay';
import { useFileDrag } from '@clowdy/components/hooks';
import { useState, type ReactNode } from 'react';

import styles from './ChatDropZone.module.css';

export interface ChatDropZoneProps {
    /** Files dropped on the zone, or pasted into it. */
    onFiles: (files: readonly File[]) => void;
    /** The page has no message box (a read-only chat): no veil, and nothing is taken. */
    disabled?: boolean;
    children: ReactNode;
}

/** The whole chat page takes files: while some are dragged over it, a veil says where they go; a paste of files lands here too. */
export function ChatDropZone({ onFiles, disabled = false, children }: ChatDropZoneProps) {
    const [over, setOver] = useState(false);

    // A veil that was up when the zone was switched off must not come back with it: the drag it belonged to is over for this zone.
    if (disabled && over) setOver(false);

    const drag = useFileDrag({ enabled: !disabled, onFileDragOver: setOver, onFilesDropped: onFiles });

    return (
        <div
            className={ styles.zone }
            onDragEnter={ drag.onDragEnter }
            onDragLeave={ drag.onDragLeave }
            onDragOver={ drag.onDragOver }
            onDrop={ drag.onDrop }
            onPaste={ drag.onPaste }
        >
            { children }
            <FileDropOverlay open={ over } label="Drop files to attach them to the message" />
        </div>
    );
}
