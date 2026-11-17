import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { Folder, Page } from '@clowdy/icons/14';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';
import { cn } from '@clowdy/lib';

import styles from './DocsTree.module.css';
import { visibleRows } from './tree';

import type { KeyboardEvent } from 'react';
import type { DocsStore } from './DocsStore';

/** The docs folder as a tree, with the keys of an ARIA tree: arrows move, open and close; Enter selects. */
export function DocsTree({ store }: { store: DocsStore }) {
    const rows = visibleRows(store.visibleTree, dir => store.isOpen(dir));
    const removed = store.removedBuffers;
    const selected = store.currentPath;
    // One row takes Tab; the others are reached with the arrows.
    const entry = [...rows.map(row => row.node.path), ...removed.map(buffer => buffer.path)].find(path => path === selected) ?? rows[0]?.node.path ?? removed[0]?.path;

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
        else if (event.key === 'ArrowRight' && row?.node.kind === 'dir') {
            if (row.open) focus(index + 1);
            else toggle(row.node.path);
        }
        else if (event.key === 'ArrowLeft' && row) {
            if (row.node.kind === 'dir' && row.open && !store.query.trim()) {
                toggle(row.node.path);

                return;
            }

            // Up to the folder that holds this row.
            for (let above = index - 1; above >= 0; above--) {
                if ((rows[above]?.depth ?? 0) < row.depth) return focus(above);
            }
        }

        function toggle(path: string) {
            event.preventDefault();
            store.toggleDir(path);
        }
    };

    return (
        <Scrollable className={ styles.scroll } contentClass={ styles.content }>
            <div role="tree" aria-label="Documents" className={ styles.tree } onKeyDown={ onKeyDown }>
                { rows.map(({ node, depth, open }) => (
                    <TreeRow
                        key={ node.path }
                        path={ node.path }
                        name={ node.name }
                        depth={ depth }
                        folder={ node.kind === 'dir' ? { open } : undefined }
                        selected={ node.kind === 'file' && node.path === selected }
                        entry={ node.path === entry }
                        unsaved={ node.kind === 'file' && store.buffers.get(node.path)?.dirty === true }
                        onActivate={ () => (node.kind === 'dir' ? store.toggleDir(node.path) : store.select(node.path)) }
                    />
                )) }

                { removed.length > 0 && (
                    <>
                        <Text variant="label" color="secondary" className={ styles.group }>Removed from disk</Text>
                        { removed.map(buffer => (
                            <TreeRow
                                key={ buffer.path }
                                path={ buffer.path }
                                name={ buffer.path }
                                depth={ 0 }
                                selected={ buffer.path === selected }
                                entry={ buffer.path === entry }
                                unsaved
                                onActivate={ () => store.select(buffer.path) }
                            />
                        )) }
                    </>
                ) }
            </div>
        </Scrollable>
    );
}

interface TreeRowProps {
    path: string;
    name: string;
    depth: number;
    /** Present for a folder. */
    folder?: { open: boolean };
    selected: boolean;
    /** The row Tab lands on. */
    entry: boolean;
    unsaved?: boolean;
    onActivate: () => void;
}

function TreeRow({ path, name, depth, folder, selected, entry, unsaved, onActivate }: TreeRowProps) {
    const Icon = folder ? Folder : Page;

    return (
        <div
            role="treeitem"
            aria-level={ depth + 1 }
            aria-expanded={ folder?.open }
            aria-selected={ selected }
            tabIndex={ entry ? 0 : -1 }
            title={ path }
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
        </div>
    );
}
