import { Button } from '@clowdy/components/Button';
import { Card } from '@clowdy/components/Card';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { useModalContext } from '@clowdy/components/Modal';
import { SortableList } from '@clowdy/components/SortableList';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { Plus } from '@clowdy/icons/14';
import { folderNames } from '@clowdy/protocol';
import { useId, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';

import styles from './AddProjectForm.module.css';
import { FolderRow } from './FolderRow';

import type { RootStore } from '../stores';

interface FolderEntry {
    path: string;
    name: string;
}

/** `added` after `folders`, leaving out the ones the list has already: a project has a folder once. */
function withFolders(folders: readonly string[], added: readonly string[]): string[] {
    return [...new Set([...folders, ...added])];
}

/** A path typed by hand, without the separators a copy from a terminal may leave at its end. A root (`/`, `C:\`) stays as it is. */
function typedPath(text: string): string {
    const path = text.trim();

    return /^([a-z]:)?[\\/]+$/i.test(path) ? path : path.replace(/[\\/]+$/, '');
}

/**
 * "Add project": a name and the folders, the first of which is the main one, where the agents work. The name follows the main folder
 * until the person types one; with no folders the daemon makes a new folder named after the project, so only then is a name needed.
 * The same folders as a project that exists switch to that project, and a toast says why nothing was added.
 */
export function AddProjectForm({ root }: { root: RootStore }) {
    const { modal } = useModalContext();
    const foldersId = useId();
    const group = useRef<HTMLDivElement>(null);
    const [folders, setFolders] = useState<string[]>([]);
    const [typedName, setTypedName] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [isPending, setIsPending] = useState(false);
    const names = folderNames(folders.map(path => ({ path })));
    const entries = folders.map((path, index): FolderEntry => ({ path, name: names[index] ?? path }));
    const mainName = names[0] ?? '';
    const name = (typedName ?? mainName).trim();
    const canSubmit = folders.length > 0 || name !== '';
    // A refusal names the folders as they were sent; once the list changes it no longer describes it.
    const changeFolders = (change: (current: string[]) => string[]) => {
        setFolders(change);
        setError('');
    };

    /**
     * The Remove button that had the focus goes with its row, and the focus would fall out of the dialog, where Escape no longer closes
     * it: it moves to the folder that takes the row's place, else the one above, else to what adds folders.
     */
    const remove = (path: string) => {
        const index = folders.indexOf(path);
        const rest = folders.filter(other => other !== path);

        flushSync(() => changeFolders(() => rest));

        const next = rest[Math.min(index, rest.length - 1)];
        const place = next === undefined ? group.current : group.current?.querySelector(`[data-folder-path="${ CSS.escape(next) }"]`);

        place?.querySelector<HTMLElement>('button, input')?.focus();
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();

        if (!canSubmit || isPending) return;

        setIsPending(true);
        setError('');

        const result = await root.addProject({ ...(name && { name }), folders });

        setIsPending(false);

        if (!result.ok) {
            setError(result.error.message);

            return;
        }

        modal.cancel();

        if (result.data.existing) toast.info({ message: `Opened ${ result.data.project.name }, it has the same folders` });
    };

    return (
        <form className={ styles.form } onSubmit={ event => void submit(event) }>
            <Text variant="heading-3">Add project</Text>

            <FormField layout="vertical">
                <FormField.Label>Name</FormField.Label>
                <Input type="text" aria-label="Name" value={ typedName ?? mainName } onChange={ setTypedName } placeholder={ mainName || 'Car Rental' } autoFocus />
            </FormField>

            <div ref={ group } className={ styles.field } role="group" aria-labelledby={ foldersId }>
                <Text id={ foldersId } variant="heading-5">Folders</Text>

                <Card variant="filled" size="lg" padding="md" gap="sm">
                    {/* The whole row drags: a grip outside its edge would stick out of the card. */}
                    { entries.length > 0
                        ? (
                            <SortableList
                                aria-label="Folders"
                                items={ entries }
                                gap="sm"
                                handle={ false }
                                className={ styles.folders }
                                getKey={ entry => entry.path }
                                getTextValue={ entry => entry.name }
                                onChange={ next => changeFolders(() => next.map(entry => entry.path)) }
                            >
                                { (entry, { isFirst }) => (
                                    <FolderRow name={ entry.name } path={ entry.path } isMain={ isFirst } onRemove={ () => remove(entry.path) } />
                                ) }
                            </SortableList>
                        )
                        : <Text variant="sm" color="secondary" align="center" className={ styles.empty }>Without folders, Clowdy creates one named after the project</Text> }

                    <FolderAdder onAdd={ added => changeFolders(current => withFolders(current, added)) } />
                </Card>
            </div>

            { error && <Text color="danger" role="alert">{ error }</Text> }

            {/* No Cancel: the window's close button, Escape and a click outside already close it. */}
            <Button type="submit" color="primary" fullWidth isDisabled={ !canSubmit } isPending={ isPending }>Add project</Button>
        </form>
    );
}

/**
 * Adds folders to the list: the system dialog in the desktop app, where several can be chosen at once and which can be opened again for
 * more; a path field in a plain browser, which has no dialog that answers a path.
 */
function FolderAdder({ onAdd }: { onAdd: (paths: string[]) => void }) {
    const [path, setPath] = useState('');
    const choose = window.desktop?.chooseDirectories;

    if (choose) {
        return <Button variant="bordered" size="sm" fullWidth onPress={ () => void choose().then(onAdd) }><Plus />Add folders…</Button>;
    }

    const add = () => {
        if (!typedPath(path)) return;

        onAdd([typedPath(path)]);
        setPath('');
    };

    return (
        <div className={ styles.path }>
            <Input
                type="text"
                aria-label="Folder path"
                value={ path }
                onChange={ setPath }
                placeholder="/Users/you/code/my-app"
                onKeyDown={ (event) => {
                    // Enter adds what is typed instead of sending the form; with the field empty it sends the form as usual.
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
