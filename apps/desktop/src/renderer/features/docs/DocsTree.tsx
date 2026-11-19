import { Button } from '@clowdy/components/Button';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { Folder, Page, Plus } from '@clowdy/icons/14';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';
import { cn } from '@clowdy/lib';
import { useRef } from 'react';

import { useCommands } from '../../hotkeys';
import { DOCS_SCOPE, docTreeCommands } from './docCommands';
import styles from './DocsTree.module.css';
import { openNewDocument } from './NewDocumentDialog';
import { visibleRows } from './tree';

import type { KeyboardEvent } from 'react';
import type { DocsStore } from './DocsStore';

/**
 * The docs folder as a tree, with the keys of an ARIA tree: arrows move, open and close; Enter selects. A project of several folders has
 * them as the top level, each with a button for a new document in it.
 */
export function DocsTree({ store }: { store: DocsStore }) {
    const rows = visibleRows(store.visibleTree, key => store.isOpen(key));
    const removed = store.removedBuffers;
    const selected = store.currentKey;
    const keys = [...rows.map(row => row.node.key), ...removed.map(buffer => buffer.key)];
    // One row takes Tab; the others are reached with the arrows.
    const entry = keys.find(key => key === selected) ?? keys[0];
    const treeRef = useRef<HTMLDivElement>(null);
    const folderPaths = new Map(store.folders.map(folder => [folder.folderId, folder.path]));

    // The `docs` scope is pushed by the screen, which also owns Save.
    useCommands(DOCS_SCOPE, docTreeCommands({ tree: () => treeRef.current, ids: () => keys, openId: () => selected }));

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
        const index = items.indexOf(document.activeElement as HTMLElement);
        const row = rows[index];
        const focus = (target: number) => {
            event.preventDefault();
            items[Math.max(0, Math.min(items.length - 1, target))]?.focus();
        };

        if (index < 0) return;

        if (event.key === 'ArrowDown') focus(index + 1);
        else if (event.key === 'ArrowUp') focus(index - 1);
        else if (event.key === 'Home') focus(0);
        else if (event.key === 'End') focus(items.length - 1);
        else if (event.key === 'ArrowRight' && row && row.node.kind !== 'file') {
            if (row.open) focus(index + 1);
            else toggle(row.node.key);
        }
        else if (event.key === 'ArrowLeft' && row) {
            if (row.node.kind !== 'file' && row.open && !store.query.trim()) {
                toggle(row.node.key);

                return;
            }

            // Up to the folder that holds this row.
            for (let above = index - 1; above >= 0; above--) {
                if ((rows[above]?.depth ?? 0) < row.depth) return focus(above);
            }
        }

        function toggle(key: string) {
            event.preventDefault();
            store.toggleDir(key);
        }
    };

    return (
        <Scrollable className={ styles.scroll } contentClass={ styles.content }>
            <div ref={ treeRef } role="tree" aria-label="Documents" className={ styles.tree } onKeyDown={ onKeyDown }>
                { rows.map(({ node, depth, open }) => (
                    <TreeRow
                        key={ node.key }
                        rowKey={ node.key }
                        title={ node.kind === 'folder' ? folderPaths.get(node.folderId) ?? node.name : node.path }
                        name={ node.name }
                        depth={ depth }
                        folder={ node.kind === 'file' ? undefined : { open } }
                        selected={ node.kind === 'file' && node.key === selected }
                        entry={ node.key === entry }
                        unsaved={ node.kind === 'file' && store.buffers.get(node.key)?.dirty === true }
                        onActivate={ () => (node.kind === 'file' ? store.select(node) : store.toggleDir(node.key)) }
                        onNewDocument={ node.kind === 'folder' ? () => openNewDocument(store, node.folderId) : undefined }
                    />
                )) }

                { removed.length > 0 && (
                    <>
                        <Text variant="label" color="secondary" className={ styles.group }>Removed from disk</Text>
                        { removed.map((buffer) => {
                            const name = store.multiFolder ? `${ store.folderName(buffer.folderId) }/${ buffer.path }` : buffer.path;

                            return (
                                <TreeRow
                                    key={ buffer.key }
                                    rowKey={ buffer.key }
                                    title={ name }
                                    name={ name }
                                    depth={ 0 }
                                    selected={ buffer.key === selected }
                                    entry={ buffer.key === entry }
                                    unsaved
                                    onActivate={ () => store.select(buffer) }
                                />
                            );
                        }) }
                    </>
                ) }
            </div>
        </Scrollable>
    );
}

interface TreeRowProps {
    /** The key of the row's document or folder (`docKey`). */
    rowKey: string;
    title: string;
    name: string;
    depth: number;
    /** Present for a folder. */
    folder?: { open: boolean };
    selected: boolean;
    /** The row Tab lands on. */
    entry: boolean;
    unsaved?: boolean;
    onActivate: () => void;
    /** A folder of the project: a new document goes into its docs folder. */
    onNewDocument?: () => void;
}

function TreeRow({ rowKey, title, name, depth, folder, selected, entry, unsaved, onActivate, onNewDocument }: TreeRowProps) {
    const Icon = folder ? Folder : Page;

    return (
        <div
            role="treeitem"
            data-key={ rowKey }
            aria-level={ depth + 1 }
            aria-expanded={ folder?.open }
            aria-selected={ selected }
            tabIndex={ entry ? 0 : -1 }
            title={ title }
            className={ cn(styles.row, selected && styles.selected) }
            style={ { paddingInlineStart: `calc(var(--spacing-md) + ${ depth } * var(--spacing-xl))` } }
            onClick={ onActivate }
            onKeyDown={ (event) => {
                if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;

                event.preventDefault();
                onActivate();
            } }
        >
            <span className={ styles.chevron } aria-hidden>
                { folder && (folder.open ? <ChevronDown /> : <ChevronRight />) }
            </span>
            <Icon className={ styles.icon } aria-hidden />
            <Text truncate className={ styles.name }>{ name }</Text>
            { unsaved && <span className={ styles.dot } role="img" aria-label="Unsaved changes" /> }
            { onNewDocument && (
                // Shown on hover, as row actions are, and while the row has the keyboard's focus, so Tab reaches it from there (hidden, it
                // takes no focus). A press of the button stops there (React Aria), so the row does not open or close.
                <Button
                    variant="transparent"
                    size="xs"
                    iconOnly
                    className={ styles.action }
                    aria-label={ `New document in ${ name }` }
                    tooltip="New document"
                    onPress={ onNewDocument }
                >
                    <Plus />
                </Button>
            ) }
        </div>
    );
}
