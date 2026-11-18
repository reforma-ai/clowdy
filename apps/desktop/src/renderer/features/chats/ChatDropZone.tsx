import { FileDropOverlay } from '@clowdy/components/FileDropOverlay';
import { useFileDrag } from '@clowdy/components/hooks';
import { Clip } from '@clowdy/icons/14';
import { useState, type ReactNode } from 'react';

import styles from './ChatDropZone.module.css';

export interface ChatDropZoneProps {
    /** Files dropped on the zone, or pasted into it. */
    onFiles: (files: readonly File[]) => void;
    children: ReactNode;
}

/** The whole chat page takes files: while some are dragged over it, a veil says where they go; a paste of files lands here too. */
export function ChatDropZone({ onFiles, children }: ChatDropZoneProps) {
    const [over, setOver] = useState(false);
    const drag = useFileDrag({ onFileDragOver: setOver, onFilesDropped: onFiles });

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
            <FileDropOverlay open={ over } icon={ <Clip /> } label="Drop files to attach them to the message" />
        </div>
    );
}
