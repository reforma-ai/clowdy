import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@clowdy/components/Alert';
import { Breadcrumb } from '@clowdy/components/Breadcrumb';
import { Button } from '@clowdy/components/Button';
import { PanelTabHeader } from '@clowdy/components/Panel';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { AttentionTriangle, Page, Save } from '@clowdy/icons/14';

import { commandTooltip } from '../../hotkeys';
import { ConflictView } from './ConflictView';
import { DocBody } from './DocBody';
import styles from './DocsMain.module.css';
import { openNewDocument } from './NewDocumentDialog';
import { ancestorDirs } from './tree';

import type { DocBuffer } from './DocBuffer';
import type { DocsStore, DocsTab } from './DocsStore';

const TABS: ReadonlyArray<{ value: DocsTab; label: string }> = [
    { value: 'editor', label: 'Editor' },
    { value: 'markdown', label: 'Markdown' },
    { value: 'preview', label: 'Preview' },
];

/** The right side: the open document, or why there is none. */
export function DocsMain({ store }: { store: DocsStore }) {
    const buffer = store.current;

    if (!store.currentPath) {
        if (store.treeStatus === 'loading') return <Loading />;

        if (store.treeStatus === 'failed') {
            return (
                <Message title="Documents cannot be loaded" text="Check that the daemon is running, then try again.">
                    <Button variant="bordered" onPress={ () => void store.loadTree() }>Retry</Button>
                </Message>
            );
        }

        return (
            <Message
                icon={ <Page width={ 24 } height={ 24 } /> }
                title="No documents yet"
                text="Notes, decisions and specs live in .clowdy/docs in your project. Agents read them before they plan."
            >
                <Button color="primary" onPress={ () => openNewDocument(store) }>New document</Button>
            </Message>
        );
    }

    if (!buffer || buffer.status === 'loading') return <Loading />;

    if (buffer.status === 'failed') {
        return (
            <Message title={ `${ buffer.path } cannot be opened` } text={ buffer.error }>
                <Button variant="bordered" onPress={ () => store.retry(buffer.path) }>Try again</Button>
            </Message>
        );
    }

    return <OpenDocument store={ store } buffer={ buffer } />;
}

function OpenDocument({ store, buffer }: { store: DocsStore; buffer: DocBuffer }) {
    const { conflict } = buffer;

    return (
        <section className={ styles.main } aria-label={ buffer.path }>
            <header className={ styles.header }>
                <PathBar store={ store } buffer={ buffer } />
                <Button
                    variant="bordered"
                    isDisabled={ !buffer.dirty || conflict !== null }
                    isPending={ buffer.saving }
                    tooltip={ commandTooltip('Save', 'docs.save') ?? 'Save' }
                    onPress={ () => void store.save(buffer) }
                >
                    <Save />
                    Save
                </Button>
            </header>

            { conflict ? <div className={ styles.rule } /> : (
                <div className={ styles.tabs }>
                    <PanelTabHeader tab={ store.tab } tabs={ TABS } onSelect={ tab => store.setTab(tab) } />
                </div>
            ) }

            { buffer.removed && !conflict && (
                <Alert color="warning" role="status" className={ styles.alert }>
                    <AlertIcon><AttentionTriangle /></AlertIcon>
                    <AlertTitle>This file was removed from disk</AlertTitle>
                    <AlertDescription>Your text is kept here as an unsaved document. Save to create the file again.</AlertDescription>
                </Alert>
            ) }

            { buffer.saveError && (
                <Alert color="danger" role="alert" className={ styles.alert }>
                    <AlertIcon><AttentionTriangle /></AlertIcon>
                    <AlertTitle>Not saved</AlertTitle>
                    <AlertDescription>{ buffer.saveError }</AlertDescription>
                </Alert>
            ) }

            <div className={ styles.body }>
                { conflict ? <ConflictView store={ store } buffer={ buffer } theirs={ conflict } /> : <DocBody store={ store } buffer={ buffer } /> }
            </div>

            <footer className={ styles.footer }>
                <Text variant="xs" color="secondary">Markdown · UTF-8</Text>
            </footer>
        </section>
    );
}

/** `docs / decisions / booking-flow.md`, with a dot while there is unsaved text. The folders reveal themselves in the tree. */
function PathBar({ store, buffer }: { store: DocsStore; buffer: DocBuffer }) {
    const name = buffer.path.slice(buffer.path.lastIndexOf('/') + 1);

    return (
        <div className={ styles.path }>
            <Breadcrumb variant="md" aria-label="Document path">
                <Breadcrumb.Link key="docs" onPress={ () => store.setQuery('') }>docs</Breadcrumb.Link>
                { ancestorDirs(buffer.path).map(dir => (
                    <Breadcrumb.Link key={ dir } onPress={ () => store.reveal(dir) }>{ dir.slice(dir.lastIndexOf('/') + 1) }</Breadcrumb.Link>
                )) }
                <Breadcrumb.Page key={ buffer.path }>{ name }</Breadcrumb.Page>
            </Breadcrumb>
            { buffer.dirty && <span className={ styles.dot } role="img" aria-label="Unsaved changes" title="Unsaved changes" /> }
        </div>
    );
}

function Loading() {
    return (
        <div className={ styles.center }>
            <Spinner size="md" />
            <Text color="secondary">Loading…</Text>
        </div>
    );
}

function Message({ icon, title, text, children }: { icon?: React.ReactNode; title: string; text: string; children?: React.ReactNode }) {
    return (
        <div className={ styles.center }>
            <div className={ styles.message }>
                { icon }
                <Text variant="heading-3">{ title }</Text>
                <Text color="secondary">{ text }</Text>
                { children }
            </div>
        </div>
    );
}
