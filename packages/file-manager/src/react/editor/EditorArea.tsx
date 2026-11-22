import { Alert, AlertAction, AlertDescription, AlertTitle } from '@clowdy/components/Alert';
import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { FileIcon } from '@clowdy/components/FileIcon';
import { For } from '@clowdy/components/For';
import { PanelEmptyState, PanelLoadingState } from '@clowdy/components/Panel';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { Close, CodeSlash, EditPen, Eye, Page } from '@clowdy/icons/14';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef } from 'react';

import { sizeLimit } from '../../documents/TextDocument';
import { basename, mediaKind } from '../../paths';
import { closeTab } from './closeTab';
import { CodeEditor } from './CodeEditor';
import styles from './EditorArea.module.css';
import { MarkdownPane } from './MarkdownPane';

import type { Extension } from '@codemirror/state';
import type { TextDocument } from '../../documents/TextDocument';
import type { FileManager } from '../../FileManager';

const Tab = observer(function Tab({ manager, document }: { manager: FileManager; document: TextDocument }) {
    const name = basename(document.path);
    const active = manager.tabs.active === document;
    const tab = useRef<HTMLDivElement>(null);

    // An opened or activated tab scrolls into the strip.
    useEffect(() => {
        if (active) {
            tab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }, [active]);

    return (
        <div
            ref={tab}
            className={styles.tab}
            data-active={active || undefined}
            data-dirty={document.dirty || undefined}
            data-deleted={document.deleted || undefined}
            onMouseDown={event => {
                // Middle click closes instead of starting autoscroll.
                if (event.button === 1) {
                    event.preventDefault();
                }
            }}
            onAuxClick={event => {
                if (event.button === 1) {
                    void closeTab(manager, document);
                }
            }}
        >
            <button
                type="button"
                role="tab"
                aria-selected={active}
                className={styles.tabName}
                onClick={() => manager.tabs.activate(document.path)}
            >
                <FileIcon path={document.path} kind="file" />
                <Text truncate>{name}</Text>
            </button>
            <Button
                variant="filling"
                color="secondary"
                size="xs"
                iconOnly
                className={styles.close}
                aria-label={`Close ${name}`}
                onPress={() => void closeTab(manager, document)}
            >
                <Close className={styles.closeIcon} />
                <span className={styles.dirtyDot} />
            </Button>
        </div>
    );
});

const ViewToggle = observer(function ViewToggle({ document }: { document: TextDocument }) {
    const rich = document.renderedView === 'rich';
    const label = rich ? 'Rich text' : 'Preview';

    return (
        <ToggleButtonGroup
            aria-label="View"
            size="sm"
            className={styles.viewToggle}
            selectedKeys={[document.view]}
            onSelectionChange={keys => {
                const [view] = keys;

                if (view === 'source' || view === 'rich' || view === 'preview') {
                    document.setView(view);
                }
            }}
        >
            <ToggleButtonGroupItem value="source" iconOnly aria-label="Source" tooltip="Source">
                <CodeSlash />
            </ToggleButtonGroupItem>
            <ToggleButtonGroupItem value={rich ? 'rich' : 'preview'} iconOnly aria-label={label} tooltip={label}>
                {rich ? <EditPen /> : <Eye />}
            </ToggleButtonGroupItem>
        </ToggleButtonGroup>
    );
});

const TabStrip = observer(function TabStrip({ manager }: { manager: FileManager }) {
    // Copy so this component tracks the tab list itself.
    const documents = manager.tabs.documents.slice();
    const active = manager.tabs.active;

    return (
        <div className={styles.tabBar}>
            <Scrollable
                vertical={false}
                horizontal
                className={styles.tabStrip}
                contentClass={styles.tabList}
                role="tablist"
            >
                <For each={documents}>
                    {document => <Tab key={document.path} manager={manager} document={document} />}
                </For>
            </Scrollable>
            <Show when={active?.status === 'text' && active.renderedView && active}>
                {document => <ViewToggle document={document} />}
            </Show>
        </div>
    );
});

function ConflictBar({ document }: { document: TextDocument }) {
    return (
        <Alert color="warning" className={styles.bar}>
            <AlertTitle>Changed on disk</AlertTitle>
            <AlertDescription>
                The file on disk is newer than your edits. Reload to discard your edits, or overwrite the file with
                them.
            </AlertDescription>
            <AlertAction>
                <Box direction="row" gap="sm">
                    <Button size="sm" variant="bordered" onPress={() => void document.reload()}>
                        Reload
                    </Button>
                    <Button size="sm" onPress={() => void document.overwrite()}>
                        Overwrite
                    </Button>
                </Box>
            </AlertAction>
        </Alert>
    );
}

function RichTextBlockedBar({ reason }: { reason: string }) {
    return (
        <Alert color="warning" className={styles.bar}>
            <AlertTitle>Shown as source</AlertTitle>
            <AlertDescription>{reason}</AlertDescription>
        </Alert>
    );
}

function BinaryPreview({ path, blob }: { path: string; blob: Blob }) {
    const kind = mediaKind(path);
    const attach = useCallback(
        (element: HTMLImageElement | HTMLMediaElement | HTMLIFrameElement | null) => {
            if (!element) {
                return;
            }

            // Typed as PDF, so the frame opens the browser's PDF viewer whatever type the provider gave the blob. The app's content security policy lets a page frame a `blob:` for this.
            const url = URL.createObjectURL(kind === 'pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob);

            element.src = url;

            return () => URL.revokeObjectURL(url);
        },
        [blob, kind]
    );

    return (
        <Show
            when={kind}
            fallback={
                <PanelEmptyState
                    title="Binary file"
                    description="This file isn’t UTF-8 text, so it can’t be edited here"
                />
            }
        >
            <Show when={kind === 'image'}>
                <img ref={attach} alt={basename(path)} className={styles.media} />
            </Show>
            <Show when={kind === 'video'}>
                <video ref={attach} controls className={styles.media} />
            </Show>
            <Show when={kind === 'audio'}>
                <audio ref={attach} controls />
            </Show>
            <Show when={kind === 'pdf'}>
                <iframe ref={attach} title={basename(path)} className={styles.pdf} />
            </Show>
        </Show>
    );
}

/** The SVG with its unsaved edits, as an image: an image runs none of the file's scripts. */
const SvgPreview = observer(function SvgPreview({ document }: { document: TextDocument }) {
    const source = document.state?.doc.toString() ?? '';

    return (
        <Box className={styles.pane} align="center" justify="center" padding="xl">
            <img
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`}
                alt={basename(document.path)}
                className={styles.media}
            />
        </Box>
    );
});

/** What a tab shows when it has no text to edit. */
const DocumentPane = observer(function DocumentPane({ document }: { document: TextDocument }) {
    const { status, blob } = document;

    return (
        <Box className={styles.pane} align="center" justify="center" padding="xl">
            <Show when={status === 'loading'}>
                <PanelLoadingState />
            </Show>
            <Show when={status === 'binary' && blob}>{file => <BinaryPreview path={document.path} blob={file} />}</Show>
            <Show when={status === 'tooLarge'}>
                <PanelEmptyState
                    title="Too large to open"
                    description={`Files over ${sizeLimit(document.path) / 1024 / 1024} MB don’t open here`}
                />
            </Show>
            <Show when={status === 'error'}>
                <PanelEmptyState title="Couldn’t open this file" description={document.error} />
            </Show>
        </Box>
    );
});

interface EditorAreaProps {
    manager: FileManager;
    editorExtensions?: Extension;
}

/** Tabs, the "Changed on disk" bar, and the editor or a note for the active tab. */
export const EditorArea = observer(function EditorArea({ manager, editorExtensions }: EditorAreaProps) {
    const active = manager.tabs.active;
    const text = active?.status === 'text' ? active : null;

    return (
        <Show
            when={manager.tabs.documents.length > 0}
            fallback={
                <PanelEmptyState
                    icon={<Page width={24} height={24} className={styles.emptyLogo} />}
                    title="Open a file to edit it"
                />
            }
        >
            <Box className={styles.area}>
                <TabStrip manager={manager} />
                <Show when={active?.conflict && active}>{document => <ConflictBar document={document} />}</Show>
                <Show when={active?.richTextBlocked}>{reason => <RichTextBlockedBar reason={reason} />}</Show>
                <div className={styles.content}>
                    <CodeEditor document={text?.view === 'source' ? text : null} extensions={editorExtensions} />
                    <Show when={text?.view === 'rich' && text}>
                        {document => <MarkdownPane key={document.path} manager={manager} document={document} />}
                    </Show>
                    <Show when={text?.view === 'preview' && text}>
                        {document => <SvgPreview document={document} />}
                    </Show>
                    <Show when={active?.status !== 'text' && active}>
                        {document => <DocumentPane document={document} />}
                    </Show>
                </div>
            </Box>
        </Show>
    );
});
