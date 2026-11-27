import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { useRef, useState } from 'react';

import styles from './AddFolderDialog.module.css';
import { openCloneRepository } from './CloneRepositoryForm';

import type { Transport } from '../daemon/transport';

export function openAddFolderDialog(transport: Transport, onAdd: (paths: string[]) => void): void {
    const lifecycle = { active: true };
    Modal.create({
        width: 400,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: true,
        handle: false,
        ariaLabel: 'Add to space',
        onCancel: () => {
            lifecycle.active = false;
        },
        onClose: () => {
            lifecycle.active = false;
        },
        component: <AddFolderDialog transport={transport} onAdd={onAdd} lifecycle={lifecycle} />,
    });
}

function AddFolderDialog({
    transport,
    onAdd,
    lifecycle,
}: {
    transport: Transport;
    onAdd: (paths: string[]) => void;
    lifecycle: { active: boolean };
}) {
    const { modal } = useModalContext();
    const [path, setPath] = useState('');
    const [enterPath, setEnterPath] = useState(false);
    const [pending, setPending] = useState(false);
    const busy = useRef(false);
    const choose = window.desktop?.chooseDirectories;
    const addPath = () => {
        const trimmed = path.trim();
        if (!trimmed) return;
        const normalized = /^([a-z]:)?[\\/]+$/i.test(trimmed) ? trimmed : trimmed.replace(/[\\/]+$/, '');
        onAdd([normalized]);
        modal.cancel();
    };

    return (
        <div className={styles.dialog}>
            <Text variant="heading-3">Add to space</Text>
            {enterPath ? (
                <div className={styles.path}>
                    <Input
                        type="text"
                        autoFocus
                        aria-label="Folder path"
                        value={path}
                        onChange={setPath}
                        placeholder="/Users/you/code/my-app"
                        onKeyDown={event => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                addPath();
                            }
                        }}
                    />
                    <Button variant="bordered" isDisabled={!path.trim()} onPress={addPath}>
                        Add folder
                    </Button>
                </div>
            ) : (
                <Button
                    variant="bordered"
                    fullWidth
                    isDisabled={pending}
                    onPress={() => {
                        if (!choose) {
                            setEnterPath(true);
                            return;
                        }
                        if (busy.current) return;
                        busy.current = true;
                        setPending(true);
                        void choose().then(
                            paths => {
                                if (!lifecycle.active) return;
                                busy.current = false;
                                setPending(false);
                                if (paths.length) {
                                    onAdd(paths);
                                    modal.cancel();
                                }
                            },
                            () => {
                                if (!lifecycle.active) return;
                                busy.current = false;
                                setPending(false);
                            }
                        );
                    }}
                >
                    Choose folder on computer
                </Button>
            )}
            <Button
                variant="bordered"
                fullWidth
                isDisabled={pending}
                onPress={() => {
                    if (busy.current) return;
                    busy.current = true;
                    setPending(true);
                    lifecycle.active = false;
                    void modal.close(false).then(() => openCloneRepository({ transport, onAdd }));
                }}
            >
                Clone Git repository
            </Button>
        </div>
    );
}
