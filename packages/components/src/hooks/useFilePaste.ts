import { filesFromDataTransfer } from '@clowdy/lib';
import { useCallback, type ClipboardEvent } from 'react';

export type UseFilePasteOptions<T extends Element = Element> = {
    enabled?: boolean;
    onFilesPasted: (files: readonly File[]) => void;
    /** Called first; if it `preventDefault`s, file paste is skipped. */
    onPaste?: (e: ClipboardEvent<T>) => void;
};

/**
 * Clipboard paste handler for file intake (screenshots, Finder copy, etc.).
 * Leaves normal text paste alone when the clipboard has no files.
 */
export function useFilePaste<T extends Element = Element>({
    enabled = true,
    onFilesPasted,
    onPaste,
}: UseFilePasteOptions<T>) {
    const handlePaste = useCallback(
        (e: ClipboardEvent<T>) => {
            onPaste?.(e);

            if (!enabled || e.defaultPrevented) {
                return;
            }

            const files = filesFromDataTransfer(e.clipboardData);

            if (files.length === 0) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();
            onFilesPasted(files);
        },
        [enabled, onFilesPasted, onPaste]
    );

    return { onPaste: handlePaste };
}
