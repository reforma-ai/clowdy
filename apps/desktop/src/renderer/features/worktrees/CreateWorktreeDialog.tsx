import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { AttentionCircle } from '@clowdy/icons/14';
import { branchNameProblem } from '@clowdy/protocol';
import { type FormEvent, useState } from 'react';

import { branchPrefix } from '../chats/branchPrefix';
import styles from './ManageWorktrees.module.css';

import type { CreatedWorktree, FolderWorktrees, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

interface CreateWorktreeOptions {
    root: RootStore;
    projectId: ProjectId;
    group: Pick<FolderWorktrees, 'folderId' | 'name'>;
    reload: () => Promise<void>;
}

export function openCreateWorktree(props: CreateWorktreeOptions): void {
    Modal.create({
        width: 420,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: true,
        handle: false,
        component: <CreateWorktreeForm {...props} />,
    });
}

function CreateWorktreeForm({ root, projectId, group, reload }: CreateWorktreeOptions) {
    const { modal } = useModalContext();
    const [name, setName] = useState('');
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<string>();
    const branchName = name.trim();
    const problem = branchName === '' ? undefined : branchNameProblem(branchName);
    const branch = `${branchPrefix.value}/${branchName || 'next'}`;

    const submit = async (event: FormEvent) => {
        event.preventDefault();

        if (!branchName || problem || pending) return;

        setFailure(undefined);
        setPending(true);

        const result = await root.command({
            type: 'workspace.create',
            projectId,
            folderId: group.folderId,
            branchName,
            branchPrefix: branchPrefix.value,
        });

        await reload();
        setPending(false);

        if (!result.ok) {
            setFailure(result.error.message);

            return;
        }

        const { warning } = result.data as CreatedWorktree;

        if (warning) toast.warning({ title: 'Worktree created', message: warning });

        modal.cancel();
    };

    return (
        <form className={styles.dialog} onSubmit={event => void submit(event)}>
            <div className={styles.heading}>
                <Text variant="heading-3">New worktree</Text>
                <Text variant="md" color="secondary" truncate>{`Repository: ${group.name}`}</Text>
            </div>
            <FormField layout="vertical">
                <FormField.Label>Worktree name</FormField.Label>
                <FormField.Description>{`Branch: ${branch}`}</FormField.Description>
                <Input
                    type="text"
                    aria-label="Worktree name"
                    value={name}
                    onChange={value => {
                        setName(value);
                        setFailure(undefined);
                    }}
                    isDisabled={pending}
                    isInvalid={problem !== undefined}
                    autoFocus
                />
                {problem && <FormField.Error>{problem}</FormField.Error>}
            </FormField>
            {failure && (
                <Alert color="danger">
                    <AlertIcon>
                        <AttentionCircle />
                    </AlertIcon>
                    <AlertDescription className="select-text">{failure}</AlertDescription>
                </Alert>
            )}
            <Box direction="row" justify="end" gap="md">
                <Button variant="filled" color="secondary" onPress={() => modal.cancel()} isDisabled={pending}>
                    Cancel
                </Button>
                <Button type="submit" color="primary" isDisabled={!branchName || !!problem} isPending={pending}>
                    Create worktree
                </Button>
            </Box>
        </form>
    );
}
