import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { branchNameProblem } from '@clowdy/protocol';
import { type FormEvent, useState } from 'react';

import { branchPrefix } from '../chats/branchPrefix';
import { refreshFolderGit } from '../openWith';
import styles from './ManageWorktrees.module.css';

import type { CreatedWorktree, FolderId, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

interface CreateWorktreeOptions {
    root: RootStore;
    projectId: ProjectId;
    folderId: FolderId;
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

function CreateWorktreeForm({ root, projectId, folderId, reload }: CreateWorktreeOptions) {
    const { modal } = useModalContext();
    const [name, setName] = useState('');
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<string>();
    const branchName = name.trim();
    const problem = branchName === '' ? undefined : branchNameProblem(branchName);
    const prefix = branchPrefix.value;
    const branch = branchName && !problem ? `${prefix}/${branchName}` : undefined;

    const submit = async (event: FormEvent) => {
        event.preventDefault();

        if (!branchName || problem || pending) return;

        setFailure(undefined);
        setPending(true);

        const result = await root.command({
            type: 'workspace.create',
            projectId,
            folderId,
            branchName,
            branchPrefix: branchPrefix.value,
        });

        if (result.ok) refreshFolderGit(projectId, folderId);

        await reload();
        setPending(false);

        if (!result.ok) {
            setFailure(result.error.message);

            return;
        }

        const { warning } = result.data as CreatedWorktree;

        if (warning) toast.warning({ title: 'Worktree created', message: warning });
        else toast.success({ title: 'Worktree ready' });

        modal.cancel();
    };

    return (
        <form className={styles.dialog} onSubmit={event => void submit(event)}>
            <Text variant="heading-3">New worktree</Text>
            <FormField layout="vertical">
                <FormField.Label>Worktree name</FormField.Label>
                <FormField.Description>
                    {branch ? (
                        <>
                            Creates a separate Git branch named <span className={styles.branchName}>{branch}</span>.{' '}
                        </>
                    ) : (
                        <>
                            Creates a separate Git branch with the prefix{' '}
                            <span className={styles.branchName}>{prefix}/</span>.{' '}
                        </>
                    )}
                    Change the prefix in Settings → Chat → Branch prefix.
                </FormField.Description>
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
                <Text variant="sm" color="danger" role="alert">
                    {failure}
                </Text>
            )}
            <Box direction="row" justify="end" gap="md">
                <Button variant="filled" color="secondary" onPress={() => modal.cancel()} isDisabled={pending}>
                    Cancel
                </Button>
                <Button
                    type="submit"
                    color="primary"
                    isDisabled={!branchName || !!problem}
                    isPending={pending}
                    spinnerPlacement="start"
                >
                    {pending ? 'Preparing worktree…' : 'Create worktree'}
                </Button>
            </Box>
        </form>
    );
}
