import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { ListBoxItem } from '@clowdy/components/List';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Select } from '@clowdy/components/Select';
import { Text } from '@clowdy/components/Text';
import { useState, type FormEvent } from 'react';

import styles from './NewDocumentDialog.module.css';

import type { FolderId } from '@clowdy/protocol';
import type { DocsStore } from './DocsStore';

/**
 * "New document": a name, with `/` for folders; the file is made under the `.clowdy/docs` of `folderId` and opened. Without a folder it goes
 * where the store says (the folder of the open document, else the main one), and a project of several folders lets the person pick another.
 */
export function openNewDocument(store: DocsStore, folderId?: FolderId): void {
    Modal.create({
        width: 420,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: false,
        title: 'New document',
        component: <NewDocumentForm store={ store } initialFolder={ folderId ?? store.newDocumentFolder } />,
    });
}

function NewDocumentForm({ store, initialFolder }: { store: DocsStore; initialFolder: FolderId }) {
    const { modal } = useModalContext();
    const [name, setName] = useState('');
    const [folderId, setFolderId] = useState(initialFolder);
    const [error, setError] = useState('');
    const [isPending, setIsPending] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();

        if (name.trim() === '' || isPending) return;

        setIsPending(true);
        setError('');

        const result = await store.createDocument(name, folderId);

        if (result.ok) modal.cancel();
        else setError(result.message);

        setIsPending(false);
    };

    return (
        <form className={ styles.form } onSubmit={ event => void submit(event) }>
            { store.multiFolder && (
                <FormField layout="vertical">
                    <FormField.Label>Folder</FormField.Label>
                    <Select
                        aria-label="Folder"
                        items={ store.folders.map(folder => ({ ...folder, id: folder.folderId })) }
                        selectedKey={ folderId }
                        onSelectionChange={ (key: unknown) => typeof key === 'string' && setFolderId(key) }
                    >
                        { folder => <ListBoxItem id={ folder.id } text={ folder.name } description={ folder.path } /> }
                    </Select>
                </FormField>
            ) }

            <FormField layout="vertical">
                <FormField.Label>Name</FormField.Label>
                <FormField.Description>Use a slash to put it in a folder, as in decisions/pricing. The .md is added for you.</FormField.Description>
                <Input type="text" aria-label="Name" value={ name } onChange={ setName } placeholder="decisions/pricing" autoFocus />
            </FormField>

            { error && <Text variant="sm" color="danger" role="alert">{ error }</Text> }

            <div className={ styles.actions }>
                <Button variant="bordered" onPress={ () => modal.cancel() }>Cancel</Button>
                <Button type="submit" color="primary" isDisabled={ name.trim() === '' } isPending={ isPending }>Create</Button>
            </div>
        </form>
    );
}
