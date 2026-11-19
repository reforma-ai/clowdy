import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { useState } from 'react';

import { AddProjectForm } from './AddProjectForm';
import styles from './projectDialogs.module.css';

import type { RootStore } from '../stores';

/**
 * No `title` option: the heading is drawn in the form, bigger, as Reforma's dialogs do, and the window's own close button floats at the corner.
 * `handle: false` keeps the dialog where it opens; window-type modals can be dragged by their title bar.
 */
const MODAL_OPTIONS = { width: 420, shadow: true, clickOut: true, closeOnEscape: true, closeButton: true, handle: false } as const;

/** "Add project…": a name and the folders, existing ones or none for a new folder, in one form (`AddProjectForm`). */
export function openAddProject(root: RootStore): void {
    // Wider than the other dialogs: a folder's row has its path beside the controls.
    Modal.create({ ...MODAL_OPTIONS, width: 460, component: <AddProjectForm root={ root } /> });
}

/**
 * Folders for a project that already exists: the system folder dialog in the desktop app, where several can be chosen, and a small form
 * with a path field in a plain browser. Resolves to the paths, or an empty list when the person closed the dialog.
 */
export async function pickFolders(): Promise<string[]> {
    const choose = window.desktop?.chooseDirectories;

    if (choose) return choose();

    return new Promise((resolve) => {
        Modal.create({ ...MODAL_OPTIONS, component: <FolderForm onPick={ path => resolve([path]) } />, onClose: () => resolve([]) });
    });
}

function FolderForm({ onPick }: { onPick: (path: string) => void }) {
    const { modal } = useModalContext();
    const [path, setPath] = useState('');

    return (
        <form
            className={ styles.form }
            onSubmit={ (event) => {
                event.preventDefault();

                if (path.trim()) {
                    onPick(path.trim());
                    modal.cancel();
                }
            } }
        >
            <Text variant="heading-3">Choose a folder</Text>
            <FormField layout="vertical">
                <FormField.Label>Folder</FormField.Label>
                <Input type="text" aria-label="Folder" value={ path } onChange={ setPath } placeholder="/Users/you/code/my-app" autoFocus />
            </FormField>
            <Button type="submit" color="primary" fullWidth isDisabled={ !path.trim() }>Use this folder</Button>
        </form>
    );
}
