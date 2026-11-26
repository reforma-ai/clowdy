import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Show } from '@clowdy/components/Show';
import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle, Close } from '@clowdy/icons/14';
import { useEffect, useId, useState } from 'react';

import { PathText } from '../../shared/PathText';
import { worktreeLabel } from '../agents/workspaceChoice';
import styles from './RemoveWorktreeDialog.module.css';
import { affectedChats, readWorktree, refreshWorktreeTarget } from './worktreeActions';
import { branchWarning, removalPlan, removeHint, STRANDED_WARNING } from './worktreeView';

import type { WorktreeInfo } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { WorktreeTarget } from './worktreeActions';
import type { RemovalPlan } from './worktreeView';

function Risk({ children, id }: { children: ReactNode; id?: string }) {
    return (
        <Alert color="warning" role="status">
            <AlertIcon>
                <AttentionCircle />
            </AlertIcon>
            <AlertDescription id={id}>{children}</AlertDescription>
        </Alert>
    );
}

/** What the person chose in the confirmation besides removing: it is read when the button is pressed. */
interface RemoveChoice {
    deleteBranch: boolean;
    disposition: 'archive' | 'delete';
}

interface RemoveMessageProps {
    worktree: WorktreeInfo;
    plan: RemovalPlan;
    choice: RemoveChoice;
    count: number;
    outside: number;
    onConfirm: () => Promise<void>;
}

/**
 * The worktree's identity and removal consequences. Deleting chats or the branch is an explicit choice; a detached HEAD has no branch to offer, and when its commits
 * are not in the base the dialog warns that commits may be lost.
 */
function RemoveMessage({ worktree, plan, choice, count, outside, onConfirm }: RemoveMessageProps) {
    const { modal } = useModalContext();
    const [deleteBranch, setDeleteBranch] = useState(choice.deleteBranch);
    const [disposition, setDisposition] = useState(choice.disposition);
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<string>();
    const warning = deleteBranch && plan.branch ? branchWarning(plan.branch) : undefined;
    const warningId = useId();
    const headingId = useId();
    const name = worktreeLabel(worktree);
    const subject = `${count} linked ${count === 1 ? 'chat' : 'chats'}`;
    const result = disposition === 'delete' ? 'permanently deleted' : 'archived';

    return (
        <Box gap="xl" padding="xxl" role="dialog" aria-modal="true" aria-labelledby={headingId}>
            <Button
                className={styles.close}
                size="sm"
                iconOnly
                variant="filling"
                color="secondary"
                aria-label="Close"
                autoFocus
                isDisabled={pending}
                onPress={() => modal.cancel()}
            >
                <Close />
            </Button>
            <Box gap="xs">
                <Text as="h2" id={headingId} variant="heading-3" wrap="anywhere" className={styles.title}>
                    {plan.kind === 'record' ? `Remove worktree record ${name}` : `Remove worktree ${name}`}
                </Text>
                <PathText path={worktree.path} variant="sm" color="secondary" />
            </Box>

            {(plan.kind !== 'plain' || count > 0) && (
                <Box gap="xs">
                    <For each={plan.notes}>
                        {note =>
                            plan.kind === 'discard' ? (
                                <Risk key={note}>{note}</Risk>
                            ) : plan.kind === 'record' ? (
                                <Text key={note} variant="md" color="secondary">
                                    {note}
                                </Text>
                            ) : null
                        }
                    </For>
                    {count > 0 && (
                        <Text variant="md" color="secondary">
                            {subject} will be {result}
                            {outside > 0 &&
                                `, including ${outside} ${outside === 1 ? 'thread' : 'threads'} in other worktrees`}
                        </Text>
                    )}
                </Box>
            )}

            {(count > 0 || plan.branch) && (
                <Box gap="md">
                    {count > 0 && (
                        <Switch
                            size="sm"
                            isDisabled={pending}
                            isSelected={disposition === 'delete'}
                            onChange={selected => {
                                choice.disposition = selected ? 'delete' : 'archive';
                                setDisposition(choice.disposition);
                            }}
                        >
                            {count === 1 ? 'Delete the chat permanently' : 'Delete the chats permanently'}
                        </Switch>
                    )}
                    <Show when={plan.branch}>
                        {branch => (
                            <Box gap="xs">
                                <Switch
                                    size="sm"
                                    isDisabled={pending}
                                    isSelected={deleteBranch}
                                    aria-label={`Delete the branch ${branch.name}`}
                                    aria-describedby={warning ? warningId : undefined}
                                    onChange={selected => {
                                        choice.deleteBranch = selected;
                                        setDeleteBranch(selected);
                                    }}
                                >
                                    Delete the branch
                                </Switch>
                                <Show when={warning}>{text => <Risk id={warningId}>{text}</Risk>}</Show>
                            </Box>
                        )}
                    </Show>
                </Box>
            )}

            <Show when={plan.stranded}>
                <Risk>{STRANDED_WARNING}</Risk>
            </Show>
            {failure && (
                <Alert color="danger" role="alert">
                    <AlertIcon>
                        <AttentionCircle />
                    </AlertIcon>
                    <AlertDescription>{failure} — close and reopen this dialog to try again</AlertDescription>
                </Alert>
            )}
            <Button
                color="danger"
                fullWidth
                isDisabled={pending || !!failure}
                isPending={pending}
                onPress={async () => {
                    if (pending) return;
                    setPending(true);
                    modal.updateOptions({ clickOut: false, closeOnEscape: false });
                    try {
                        await onConfirm();
                        modal.cancel();
                    } catch (error) {
                        setPending(false);
                        modal.updateOptions({ clickOut: true, closeOnEscape: true });
                        setFailure(error instanceof Error ? error.message : 'Something went wrong');
                    }
                }}
            >
                {plan.confirmLabel}
            </Button>
        </Box>
    );
}

function ReadRemoval({ target }: { target: WorktreeTarget }) {
    const { modal } = useModalContext();
    const [content, setContent] = useState<ReactNode>();
    const [failure, setFailure] = useState<string>();
    useEffect(() => {
        let active = true;
        const { root, projectId, folderId } = target;
        async function read() {
            try {
                const { worktree, snapshot } = await readWorktree(target);
                const chats = affectedChats(worktree, snapshot, folderId);
                const hint = worktree.main ? 'This is the project checkout' : (removeHint(worktree) ?? chats.blocker);
                if (hint) throw new Error(hint);
                const plan = removalPlan(worktree);
                const choice: RemoveChoice = {
                    deleteBranch:
                        !worktree.missing && worktree.changes === 0 && !worktree.submodules && !!plan.branch?.selected,
                    disposition: 'archive',
                };
                if (active)
                    setContent(
                        <RemoveMessage
                            worktree={worktree}
                            plan={plan}
                            choice={choice}
                            count={chats.ids.size}
                            outside={chats.outside}
                            onConfirm={async () => {
                                const { deleteBranch, disposition } = choice;
                                if (chats.ids.size === 0 || deleteBranch || plan.kind === 'discard') {
                                    try {
                                        const current = await readWorktree(target);
                                        if (
                                            chats.ids.size === 0 &&
                                            affectedChats(current.worktree, current.snapshot, folderId).ids.size > 0
                                        ) {
                                            throw new Error('The chats linked to this worktree changed. Try again');
                                        }
                                        // The switch authorizes deleting the branch that was shown, not a different
                                        // checkout or new commits made while this confirmation was open.
                                        if (
                                            deleteBranch &&
                                            (current.worktree.branch !== worktree.branch ||
                                                current.worktree.head !== worktree.head ||
                                                current.worktree.base !== worktree.base ||
                                                current.worktree.merged !== worktree.merged)
                                        )
                                            throw new Error('The branch changed. Try again');
                                        if (
                                            plan.kind === 'discard' &&
                                            (current.worktree.changes !== worktree.changes ||
                                                current.worktree.submodules !== worktree.submodules ||
                                                current.worktree.branch !== worktree.branch ||
                                                current.worktree.head !== worktree.head)
                                        )
                                            throw new Error('The local changes in this worktree changed. Try again');
                                    } catch (error) {
                                        await refreshWorktreeTarget(target);
                                        throw error;
                                    }
                                }
                                const result = await root.command({
                                    type: 'workspace.remove',
                                    projectId,
                                    folderId,
                                    path: worktree.path,
                                    ...(plan.kind === 'discard' && { discard: true }),
                                    ...(plan.branch && deleteBranch && { deleteBranch: true }),
                                    ...(chats.ids.size > 0 && {
                                        chatDisposition: disposition,
                                        expectedChatIds: [...chats.ids],
                                    }),
                                });
                                await refreshWorktreeTarget(target, chats.affected);
                                if (!result.ok) throw new Error(result.error.message);
                            }}
                        />
                    );
            } catch (error) {
                if (active) {
                    setFailure(error instanceof Error ? error.message : String(error));
                    void refreshWorktreeTarget(target).catch(() => undefined);
                }
            }
        }
        void read();
        return () => {
            active = false;
        };
    }, [target]);
    if (content) return content;
    return (
        <Box gap="xl" padding="xxl" role="dialog" aria-modal="true" aria-label="Remove worktree">
            <Button
                className={styles.close}
                size="sm"
                iconOnly
                variant="filling"
                color="secondary"
                aria-label="Close"
                autoFocus
                onPress={() => modal.cancel()}
            >
                <Close />
            </Button>
            <Text as="h2" variant="heading-3">
                Remove worktree
            </Text>
            {failure ? (
                <Alert color="danger" role="alert">
                    <AlertIcon>
                        <AttentionCircle />
                    </AlertIcon>
                    <AlertDescription>{failure}</AlertDescription>
                </Alert>
            ) : (
                <Text role="status" color="secondary">
                    Checking worktree…
                </Text>
            )}
        </Box>
    );
}

/** Open immediately while reading current Git and chat state. */
export async function openRemoveWorktree(target: WorktreeTarget): Promise<void> {
    Modal.create({
        width: 440,
        zIndex: 101100,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: false,
        component: <ReadRemoval target={target} />,
    });
}
