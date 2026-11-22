import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { PanelLoadingState } from '@clowdy/components/Panel';
import { history, historyField } from '@codemirror/commands';
import { observer } from 'mobx-react-lite';
import { lazy, Suspense, useEffect, useMemo } from 'react';

import { basename, dirname, extname, joinPath, normalizePath } from '../../paths';
import styles from './EditorArea.module.css';

import type { TextDocument } from '../../documents/TextDocument';
import type { FileManager } from '../../FileManager';

// Its own chunk, loaded on the first rich markdown tab.
const MarkdownEditor = lazy(() =>
    import('@clowdy/components/MarkdownEditor').then(module => ({ default: module.MarkdownEditor }))
);

/** Object URLs for the images a document links by project path, each file read once. */
function projectImages(manager: FileManager, document: TextDocument) {
    const urls = new Map<string, Promise<string>>();

    return {
        resolve: (src: string): Promise<string> => {
            // A URL with a scheme (`https:`, `data:`) or a protocol-relative one loads as written.
            if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) {
                return Promise.resolve(src);
            }

            const file = src.replace(/[?#].*/, '');
            const path = file.startsWith('/') ? normalizePath(file) : joinPath(dirname(document.path), file);
            let url = urls.get(path);

            if (!url) {
                url = (async () => {
                    const content = await manager.provider.read(decodeURIComponent(path));
                    const type = extname(path) === 'svg' ? 'image/svg+xml' : '';

                    return URL.createObjectURL(
                        new Blob([content.kind === 'text' ? content.text : content.blob], { type })
                    );
                })();
                urls.set(path, url);
            }

            return url;
        },
        revoke: () => {
            for (const url of urls.values()) {
                void url.then(URL.revokeObjectURL, () => undefined);
            }
        },
    };
}

/** A markdown document as rich text. Edits go into its text; content it would lose shows read-only, and a file too large shows as source. */
export const MarkdownPane = observer(function MarkdownPane({
    manager,
    document,
}: {
    manager: FileManager;
    document: TextDocument;
}) {
    const images = useMemo(() => projectImages(manager, document), [manager, document]);

    useEffect(() => images.revoke, [images]);

    // Rich edits join the code editor's undo history, also in a file the code editor has not shown yet.
    useEffect(() => {
        if (!document.state?.field(historyField, false)) {
            document.configure(history());
        }
    }, [document]);

    return (
        <Suspense
            fallback={
                <Box className={styles.pane} align="center" justify="center">
                    <PanelLoadingState />
                </Box>
            }
        >
            <MarkdownEditor
                className={styles.pane}
                aria-label={basename(document.path)}
                value={document.state?.doc.toString() ?? ''}
                resolveImageSrc={images.resolve}
                editable={!manager.readonly}
                onChange={text => document.replaceText(text)}
                onUnsupported={reason => document.blockRichText(reason)}
                unsupportedAction={
                    <Button variant="bordered" size="sm" onPress={() => document.setView('source')}>
                        Edit in source
                    </Button>
                }
            />
        </Suspense>
    );
});
