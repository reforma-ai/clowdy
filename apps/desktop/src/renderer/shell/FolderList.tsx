import { Button } from '@clowdy/components/Button';
import { Card } from '@clowdy/components/Card';
import { Input } from '@clowdy/components/Input';
import { SortableList, type SortableListDropContext } from '@clowdy/components/SortableList';
import { Text } from '@clowdy/components/Text';
import { Plus } from '@clowdy/icons/14';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import styles from './FolderList.module.css';
import { FolderRow } from './FolderRow';

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
    /** What the card says while there are no folders. */
    empty?: ReactNode;
}

/**
 * The folders of a project in one filled card, in the Add project form and on the project's page in Settings: a row for each, dragged into
 * another order by the whole row (a grip outside its edge would stick out of the card) and removed one by one, and Add folders… across the
 * bottom of the card.
 */
export function FolderList<T>({ items, getKey, getPath, getName, renderDetails, renderActions, onRemove, isRemoveDisabled, onReorder, canDrop, onAdd, empty }: FolderListProps<T>) {
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

        (row?.querySelector<HTMLElement>('button[aria-label^="Remove"]') ?? card.current?.querySelector<HTMLElement>('[data-folder-adder] :is(button, input)'))?.focus();
    }, [keys]);

    const remove = onRemove && ((item: T, index: number) => {
        removedAt.current = index;
        void Promise.resolve(onRemove(item, index)).then((removed) => {
            if (removed === false) removedAt.current = null;
        });
    });

    const row = (item: T, index: number) => (
        <FolderRow
            name={ getName(item) }
            path={ getPath(item) }
            isMain={ index === 0 && (onAdd !== undefined || items.length > 1) }
            onRemove={ remove && (() => remove(item, index)) }
            isRemoveDisabled={ isRemoveDisabled?.(item) }
            actions={ renderActions?.(item) }
        >
            { renderDetails?.(item) }
        </FolderRow>
    );

    const rows = onReorder
        ? (
            <SortableList
                aria-label="Folders"
                items={ items as T[] }
                gap="sm"
                handle={ false }
                className={ styles.sortable }
                getKey={ getKey }
                getTextValue={ getName }
                canDrop={ canDrop }
                onChange={ onReorder }
            >
                { (item, { index }) => row(item, index) }
            </SortableList>
        )
        : <div className={ styles.rows }>{ items.map((item, index) => <div key={ getKey(item) }>{ row(item, index) }</div>) }</div>;

    return (
        <Card ref={ card } variant="filled" size="lg" padding="md" gap="sm" className={ styles.card }>
            { items.length > 0 ? rows : empty && <Text variant="sm" color="secondary" align="center" className={ styles.empty }>{ empty }</Text> }
            { onAdd && <FolderAdder onAdd={ onAdd } /> }
        </Card>
    );
}

/** A path typed by hand, without the separators a copy from a terminal may leave at its end. A root (`/`, `C:\`) stays as it is. */
function typedPath(text: string): string {
    const path = text.trim();

    return /^([a-z]:)?[\\/]+$/i.test(path) ? path : path.replace(/[\\/]+$/, '');
}

/**
 * Adds folders: the system dialog in the desktop app, where several can be chosen at once and which can be opened again for more; a path
 * field in a plain browser, which has no dialog that answers a path.
 */
function FolderAdder({ onAdd }: { onAdd: (paths: string[]) => void }) {
    const [path, setPath] = useState('');
    const choose = window.desktop?.chooseDirectories;

    if (choose) {
        return (
            <div data-folder-adder>
                <Button variant="bordered" size="sm" fullWidth onPress={ () => void choose().then(onAdd) }><Plus />Add folders…</Button>
            </div>
        );
    }

    const add = () => {
        if (!typedPath(path)) return;

        onAdd([typedPath(path)]);
        setPath('');
    };

    return (
        <div className={ styles.path } data-folder-adder>
            <Input
                type="text"
                aria-label="Folder path"
                value={ path }
                onChange={ setPath }
                placeholder="/Users/you/code/my-app"
                onKeyDown={ (event) => {
                    // Enter adds what is typed instead of sending a form around it; with the field empty a form is sent as usual.
                    if (event.key === 'Enter' && typedPath(path)) {
                        event.preventDefault();
                        add();
                    }
                } }
            />
            <Button variant="bordered" isDisabled={ !typedPath(path) } onPress={ add }>Add folder</Button>
        </div>
    );
}
