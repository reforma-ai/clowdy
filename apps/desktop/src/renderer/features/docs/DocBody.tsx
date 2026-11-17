import { Button } from '@clowdy/components/Button';
import { CodeTextarea } from '@clowdy/components/CodeTextarea';
import { MarkdownEditor } from '@clowdy/components/MarkdownEditor';
import { Text } from '@clowdy/components/Text';
import { useState } from 'react';

import styles from './DocBody.module.css';

import type { DocBuffer } from './DocBuffer';
import type { DocsStore } from './DocsStore';

/** The open document in the selected tab: the visual editor, the raw Markdown, or a read-only preview. All three share `buffer.text`. */
export function DocBody({ store, buffer }: { store: DocsStore; buffer: DocBuffer }) {
    if (store.tab === 'markdown') {
        return (
            <div className={ styles.source }>
                <CodeTextarea
                    key={ buffer.path }
                    variant="transparent"
                    autoResize={ false }
                    height="100%"
                    aria-label="Markdown source"
                    value={ buffer.text }
                    onChange={ text => buffer.edit(text) }
                />
            </div>
        );
    }

    return <RichView key={ buffer.path } buffer={ buffer } editable={ store.tab === 'editor' } onEditSource={ () => store.setTab('markdown') } />;
}

function RichView({ buffer, editable, onEditSource }: { buffer: DocBuffer; editable: boolean; onEditSource: () => void }) {
    // The editor does not load a file this large; it says so once, for the text it was given.
    const [tooLarge, setTooLarge] = useState<{ text: string; reason: string } | null>(null);
    const blocked = tooLarge?.text === buffer.text ? tooLarge.reason : null;

    return (
        <>
            <MarkdownEditor
                value={ buffer.text }
                editable={ editable }
                aria-label={ buffer.path }
                onChange={ text => buffer.edit(text) }
                onUnsupported={ reason => setTooLarge({ text: buffer.text, reason }) }
                unsupportedAction={ <Button size="sm" variant="bordered" onPress={ onEditSource }>Edit as Markdown</Button> }
            />

            { blocked && (
                <div className={ styles.blocked }>
                    <Text variant="heading-5">{ editable ? 'This document is too big for the visual editor' : 'This document is too big to preview' }</Text>
                    <Text color="secondary">{ blocked }</Text>
                    { editable && <Button variant="bordered" onPress={ onEditSource }>Edit as Markdown</Button> }
                </div>
            ) }
        </>
    );
}
