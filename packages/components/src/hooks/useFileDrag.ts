import { filesFromDataTransfer } from '@clowdy/lib';
import { useCallback, useEffect, useRef, type DragEvent } from 'react';

import { useFilePaste } from './useFilePaste';

function hasFileDrag(e: DragEvent) {
    return [...e.dataTransfer.types].includes('Files');
}

export type UseFileDragOptions = {
    enabled?: boolean;
    onFileDragOver: (over: boolean) => void;
    onFilesDropped: (files: readonly File[]) => void;
    onDragEnter?: (e: DragEvent<HTMLDivElement>) => void;
    onDragLeave?: (e: DragEvent<HTMLDivElement>) => void;
    onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
    onDrop?: (e: DragEvent<HTMLDivElement>) => void;
};

/**
 * File drag-over / drop handlers for a droppable region.
 * Also returns {@link onPaste} (same intake path as drop) for the same element.
 *
 * Overlay clears on leave even when `dataTransfer.types` is empty (common on leave),
 * on drop, and on document `dragend` so it cannot stick after a cancelled drag.
 */
export function useFileDrag({
    enabled = true,
    onFileDragOver,
    onFilesDropped,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
}: UseFileDragOptions) {
    const onFileDragOverRef = useRef(onFileDragOver);

    onFileDragOverRef.current = onFileDragOver;

    const { onPaste } = useFilePaste({
        enabled,
        onFilesPasted: onFilesDropped,
    });

    const clearOver = useCallback(() => {
        onFileDragOverRef.current(false);
    }, []);

    useEffect(() => {
        const onDragEnd = () => clearOver();

        document.addEventListener('dragend', onDragEnd);

        return () => document.removeEventListener('dragend', onDragEnd);
    }, [clearOver]);

    const handleDragEnter = useCallback(
        (e: DragEvent<HTMLDivElement>) => {
            onDragEnter?.(e);

            if (!enabled || e.defaultPrevented || !hasFileDrag(e)) {
                return;
            }

            e.preventDefault();
            onFileDragOver(true);
        },
        [enabled, onDragEnter, onFileDragOver]
    );

    const handleDragLeave = useCallback(
        (e: DragEvent<HTMLDivElement>) => {
            onDragLeave?.(e);

            if (e.defaultPrevented) {
                return;
            }

            const related = e.relatedTarget as Node | null;

            // Still inside the droppable (moved onto a child).
            if (related && e.currentTarget.contains(related)) {
                return;
            }

            // Do not require `Files` in types — leave often has an empty list.
            onFileDragOver(false);
        },
        [onDragLeave, onFileDragOver]
    );

    const handleDragOver = useCallback(
        (e: DragEvent<HTMLDivElement>) => {
            onDragOver?.(e);

            if (!enabled || e.defaultPrevented || !hasFileDrag(e)) {
                return;
            }

            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        },
        [enabled, onDragOver]
    );

    const handleDrop = useCallback(
        (e: DragEvent<HTMLDivElement>) => {
            // Always reset — even when disabled — so the overlay cannot stick.
            clearOver();
            onDrop?.(e);

            if (!enabled) {
                return;
            }

            const files = filesFromDataTransfer(e.dataTransfer);

            // Don't gate on `defaultPrevented` — chrome/UI under the cursor can flip it
            // while `files` are still present (MediaUrlField drop was a silent no-op).
            // Nested drop zones should `stopPropagation` instead.
            if (files.length === 0 && !hasFileDrag(e)) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            if (files.length > 0) {
                onFilesDropped(files);
            }
        },
        [clearOver, enabled, onDrop, onFilesDropped]
    );

    return {
        onDragEnter: handleDragEnter,
        onDragLeave: handleDragLeave,
        onDragOver: handleDragOver,
        onDrop: handleDrop,
        onPaste,
    };
}
