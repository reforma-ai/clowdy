import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { useState, type FormEvent } from 'react';

import styles from './NewDocumentDialog.module.css';

import type { DocsStore } from './DocsStore';

/** "New document": a name, with `/` for folders; the file is made empty under `.clowdy/docs` and opened. */
export function openNewDocument(store: DocsStore): void {
    Modal.create({
        width: 420,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: false,
        title: 'New document',
        component: <NewDocumentForm store={ store } />,
    });
}

function NewDocumentForm({ store }: { store: DocsStore }) {
    const { modal } = useModalContext();
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [isPending, setIsPending] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();

        if (name.trim() === '' || isPending) return;

        setIsPending(true);
        setError('');

        const result = await store.createDocument(name);

        if (result.ok) modal.cancel();
        else setError(result.message);

        setIsPending(false);
    };

    return (
        <form className={ styles.form } onSubmit={ event => void submit(event) }>
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
