import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { SortableList, type SortableListDropContext } from '@clowdy/components/SortableList';
import { Text } from '@clowdy/components/Text';
import { Plus, Version } from '@clowdy/icons/14';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { openAddFolderDialog } from './AddFolderDialog';
import { openCloneRepository } from './CloneRepositoryForm';
import styles from './FolderList.module.css';
import { FolderRow } from './FolderRow';

import type { Transport } from '../daemon/transport';

export interface FolderListProps<T> {
    /** The folders in order: the first is the main one, marked Main where the list can hold more than one. */
    items: readonly T[];
    getKey: (item: T) => string;
    getPath: (item: T) => string;
    /** The short name `folderNames` gives it among the folders: the row's title, and what a screen reader hears while it is dragged. */
    getName: (item: T) => string;
    /** Lines under a folder's path: a warning. */
    renderDetails?: (item: T) => ReactNode;
    /** Buttons at the end of a folder's row, before Remove: Open in GitHub. */
    renderActions?: (item: T) => ReactNode;
    /**
     * Takes the folder out, and says whether it went: a promise for a change the daemon makes. Once the row is gone the focus moves to the
     * folder in its place, else the one above, else to what adds folders, so it does not fall out of the page. Absent: no row has Remove.
     */
    onRemove?: (item: T, index: number) => void | Promise<boolean>;
    isRemoveDisabled?: (item: T) => boolean;
    /** The folders in the order the person dragged them to. Absent: the list does not drag. */
    onReorder?: (items: T[]) => void;
    canDrop?: (context: SortableListDropContext<T>) => boolean;
    /** The paths the person picked or typed. Absent: nothing can be added here. */
    onAdd?: (paths: string[]) => void;
    /**
     * The daemon the list clones a repository with, so that Clone repository… sits beside Add folders…: the folder it makes goes to `onAdd` like one the person picked.
     * Absent: the list does not clone.
     */
    transport?: Transport;
    useAddDialog?: boolean;
    /** What the card says while there are no folders. */
    empty?: ReactNode;
}

/**
 * The folders of a project in one card, in the Add project form and on the project's page in Settings: a row for each, a hairline between
 * them, dragged into another order by the whole row (a grip outside its edge would stick out of the card) and removed one by one, and Add
 * folders… as the last row, with Clone repository… under it when the list has a daemon to clone with.
 */
export function FolderList<T>({
    items,
    getKey,
    getPath,
    getName,
    renderDetails,
    renderActions,
    onRemove,
    isRemoveDisabled,
    onReorder,
    canDrop,
    onAdd,
    transport,
    useAddDialog,
    empty,
}: FolderListProps<T>) {
    const card = useRef<HTMLDivElement>(null);
    // The place of a removed row, where the focus goes once the row is gone.
    const removedAt = useRef<number | null>(null);
    const keys = items.map(getKey).join('\n');

    useEffect(() => {
        const index = removedAt.current;

        if (index === null) return;

        removedAt.current = null;

        const rows = card.current?.querySelectorAll('[data-folder-path]') ?? [];
        const row = rows[Math.min(index, rows.length - 1)];

        (
            row?.querySelector<HTMLElement>('button[aria-label^="Remove"]') ??
            card.current?.querySelector<HTMLElement>('[data-folder-adder] :is(button, input)')
        )?.focus();
    }, [keys]);

    const remove =
        onRemove &&
        ((item: T, index: number) => {
            removedAt.current = index;
            void Promise.resolve(onRemove(item, index)).then(removed => {
                if (removed === false) removedAt.current = null;
            });
        });

    const row = (item: T, index: number) => (
        <FolderRow
            name={getName(item)}
            path={getPath(item)}
            isMain={index === 0 && (onAdd !== undefined || items.length > 1)}
            onRemove={remove && (() => remove(item, index))}
            isRemoveDisabled={isRemoveDisabled?.(item)}
            actions={renderActions?.(item)}
        >
            {renderDetails?.(item)}
        </FolderRow>
    );

    const rows = onReorder ? (
        <SortableList
            aria-label="Folders"
            items={items as T[]}
            gap="sm"
            handle={false}
            className={`${styles.list} ${styles.draggable}`}
            getKey={getKey}
            getTextValue={getName}
            canDrop={canDrop}
            onChange={onReorder}
        >
            {(item, { index }) => row(item, index)}
        </SortableList>
    ) : (
        <div className={styles.list}>
            {items.map((item, index) => (
                <div key={getKey(item)}>{row(item, index)}</div>
            ))}
        </div>
    );

    return (
        <div ref={card} className={styles.card}>
            {items.length > 0
                ? rows
                : empty && (
                      <Text variant="sm" color="secondary" align="center" className={styles.empty}>
                          {empty}
                      </Text>
                  )}
            {onAdd &&
                (useAddDialog && transport ? (
                    <div data-folder-adder>
                        <button
                            type="button"
                            className={styles.add}
                            onClick={() => openAddFolderDialog(transport, onAdd)}
                        >
                            <Plus /> Add…
                        </button>
                    </div>
                ) : (
                    <FolderAdder onAdd={onAdd} transport={transport} />
                ))}
        </div>
    );
}

/** A path typed by hand, without the separators a copy from a terminal may leave at its end. A root (`/`, `C:\`) stays as it is. */
function typedPath(text: string): string {
    const path = text.trim();

    return /^([a-z]:)?[\\/]+$/i.test(path) ? path : path.replace(/[\\/]+$/, '');
}

/**
 * Adds folders: the system dialog in the desktop app, where several can be chosen at once and which can be opened again for more; a path
 * field in a plain browser, which has no dialog that answers a path. Beside it Clone repository…, when the list has a daemon to clone
 * with: a repository from an address becomes a folder the list adds like a picked one.
 */
function FolderAdder({ onAdd, transport }: { onAdd: (paths: string[]) => void; transport?: Transport }) {
    const [path, setPath] = useState('');
    const choose = window.desktop?.chooseDirectories;
    const clone = transport && (
        <button type="button" className={styles.add} onClick={() => openCloneRepository({ transport, onAdd })}>
            <Version />
            Clone repository…
        </button>
    );

    if (choose) {
        return (
            <div className={styles.adders} data-folder-adder>
                <button type="button" className={styles.add} onClick={() => void choose().then(onAdd)}>
                    <Plus />
                    Add folders…
                </button>
                {clone}
            </div>
        );
    }

    const add = () => {
        if (!typedPath(path)) return;

        onAdd([typedPath(path)]);
        setPath('');
    };

    return (
        <div data-folder-adder>
            <div className={styles.path}>
                <Input
                    type="text"
                    aria-label="Folder path"
                    value={path}
                    onChange={setPath}
                    placeholder="/Users/you/code/my-app"
                    onKeyDown={event => {
                        // Enter adds what is typed instead of sending a form around it; with the field empty a form is sent as usual.
                        if (event.key === 'Enter' && typedPath(path)) {
                            event.preventDefault();
                            add();
                        }
                    }}
                />
                <Button variant="bordered" isDisabled={!typedPath(path)} onPress={add}>
                    Add folder
                </Button>
            </div>
            {clone}
        </div>
    );
}
