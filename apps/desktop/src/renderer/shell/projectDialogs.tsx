import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { useState, type FormEvent } from 'react';

import styles from './projectDialogs.module.css';

import type { CommandResult } from '@clowdy/protocol';
import type { RootStore } from '../stores';

/**
 * No `title` option: the heading is drawn in the form, bigger, as Reforma's dialogs do, and the window's own close button floats at the corner.
 * `handle: false` keeps the dialog where it opens; window-type modals can be dragged by their title bar.
 */
const MODAL_OPTIONS = { width: 420, shadow: true, clickOut: true, closeOnEscape: true, closeButton: true, handle: false } as const;

/** "Create project": a name, and optionally the folder it lives in. */
export function openCreateProject(root: RootStore): void {
    Modal.create({ ...MODAL_OPTIONS, component: <ProjectForm root={ root } mode="create" /> });
}

/** "Open existing project…": the system folder dialog in the desktop app; a path field in a plain browser. */
export async function openExistingProject(root: RootStore): Promise<void> {
    const choose = window.desktop?.chooseDirectory;

    if (!choose) {
        Modal.create({ ...MODAL_OPTIONS, component: <ProjectForm root={ root } mode="open" /> });

        return;
    }

    const path = await choose();

    if (path) showFailure(await root.openProject(path));
}

function showFailure(result: CommandResult): void {
    if (!result.ok) toast.error({ message: result.error.message });
}

function ProjectForm({ root, mode }: { root: RootStore; mode: 'create' | 'open' }) {
    const { modal } = useModalContext();
    const [name, setName] = useState('');
    const [path, setPath] = useState('');
    const [error, setError] = useState('');
    const [isPending, setIsPending] = useState(false);
    const chooseDirectory = window.desktop?.chooseDirectory;
    const canSubmit = mode === 'create' ? name.trim() !== '' : path.trim() !== '';

    const submit = async (event: FormEvent) => {
        event.preventDefault();

        if (!canSubmit || isPending) return;

        setIsPending(true);
        setError('');

        const result = mode === 'create' ? await root.createProject(name.trim(), path.trim() || undefined) : await root.openProject(path.trim());

        if (result.ok) modal.cancel();
        else setError(result.error.message);

        setIsPending(false);
    };

    return (
        <form className={ styles.form } onSubmit={ event => void submit(event) }>
            <Text variant="heading-3">{ mode === 'create' ? 'Create project' : 'Open existing project' }</Text>

            { mode === 'create' && (
                <FormField layout="vertical">
                    <FormField.Label>Name</FormField.Label>
                    <Input type="text" aria-label="Name" value={ name } onChange={ setName } placeholder="Car Rental" autoFocus />
                </FormField>
            ) }

            <FormField layout="vertical">
                <FormField.Label>{ mode === 'create' ? 'Folder (optional)' : 'Folder' }</FormField.Label>
                <div className={ styles.path }>
                    <Input
                        type="text"
                        aria-label="Folder"
                        value={ path }
                        onChange={ setPath }
                        placeholder={ mode === 'create' ? 'A new folder is made when this is empty' : '/Users/you/code/my-app' }
                        autoFocus={ mode === 'open' }
                    />
                    { chooseDirectory && (
                        <Button variant="bordered" onPress={ () => void chooseDirectory().then(chosen => chosen && setPath(chosen)) }>Choose…</Button>
                    ) }
                </div>
            </FormField>

            { error && <Text color="danger" role="alert">{ error }</Text> }

            {/* No Cancel: the window's close button, Escape and a click outside already close it. */}
            <Button type="submit" color="primary" size="lg" fullWidth isDisabled={ !canSubmit } isPending={ isPending }>
                { mode === 'create' ? 'Create project' : 'Open project' }
            </Button>
        </form>
    );
}
