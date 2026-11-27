import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { folderNames } from '@clowdy/protocol';
import { type FormEvent, useId, useState } from 'react';

import styles from './AddProjectForm.module.css';
import { FolderList } from './FolderList';

import type { RootStore } from '../stores';

interface FolderEntry {
    path: string;
    name: string;
}

/** `added` after `folders`, leaving out the ones the list has already: a project has a folder once. */
function withFolders(folders: readonly string[], added: readonly string[]): string[] {
    return [...new Set([...folders, ...added])];
}

/**
 * "Add project": a name and the folders, the first of which is the main one, where the agents work. The name follows the main folder
 * until the person types one; with no folders the daemon makes a new folder named after the project, so only then is a name needed.
 * The same folders as a project that exists switch to that project, and a toast says why nothing was added.
 */
export function AddProjectForm({ root }: { root: RootStore }) {
    const { modal } = useModalContext();
    const foldersId = useId();
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

        if (result.data.existing)
            toast.info({ message: `Opened ${result.data.project.name}, it has the same folders` });
    };

    return (
        <form className={styles.form} onSubmit={event => void submit(event)}>
            <Text variant="heading-3">Add space</Text>

            <FormField layout="vertical">
                <FormField.Label>Name</FormField.Label>
                <Input
                    type="text"
                    aria-label="Name"
                    value={typedName ?? mainName}
                    onChange={setTypedName}
                    placeholder={mainName || 'Car Rental'}
                    autoFocus
                />
            </FormField>

            <div className={styles.field} role="group" aria-labelledby={foldersId}>
                <Text id={foldersId} variant="heading-5">
                    Folders
                </Text>
                <FolderList
                    items={entries}
                    getKey={entry => entry.path}
                    getPath={entry => entry.path}
                    getName={entry => entry.name}
                    // The focus moves on from a removed row by itself, so it stays in the dialog, where Escape closes it.
                    onRemove={entry => changeFolders(current => current.filter(path => path !== entry.path))}
                    onReorder={next => changeFolders(() => next.map(entry => entry.path))}
                    onAdd={added => changeFolders(current => withFolders(current, added))}
                    transport={root.transport}
                    empty="Without folders, Clowdy creates one named after the space"
                />
            </div>

            {error && (
                <Text color="danger" role="alert">
                    {error}
                </Text>
            )}

            {/* No Cancel: the window's close button, Escape and a click outside already close it. */}
            <Button type="submit" color="primary" fullWidth isDisabled={!canSubmit} isPending={isPending}>
                Add space
            </Button>
        </form>
    );
}
