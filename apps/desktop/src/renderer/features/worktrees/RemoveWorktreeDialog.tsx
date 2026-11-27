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
import { samePath, worktreeLabel } from '../agents/workspaceChoice';
import styles from './RemoveWorktreeDialog.module.css';
import { affectedChats, readWorktree, refreshWorktreeTarget } from './worktreeActions';
import { branchWarning, removalPlan, removeHint, STRANDED_WARNING } from './worktreeView';

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
    branchTouched?: boolean;
    chatsTouched?: boolean;
}

interface RemoveMessageProps {
    worktree: { path: string; branch?: string; head?: string };
    plan: RemovalPlan;
    choice: RemoveChoice;
    count: number;
    outside: number;
    onConfirm: () => Promise<void>;
    checking?: boolean;
    readFailure?: string;
    changed?: boolean;
    chatsKnown?: boolean;
    partialChats?: boolean;
}

/**
 * The worktree's identity and removal consequences. Deleting chats or the branch is an explicit choice; a detached HEAD has no branch to offer, and when its commits
 * are not in the base the dialog warns that commits may be lost.
 */
function RemoveMessage({
    worktree,
    plan,
    choice,
    count,
    outside,
    onConfirm,
    checking,
    readFailure,
    changed,
    chatsKnown = true,
    partialChats = false,
}: RemoveMessageProps) {
    const { modal } = useModalContext();
    const [, redraw] = useState(0);
    const { deleteBranch, disposition } = choice;
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<string>();
    const warning = deleteBranch && plan.branch ? branchWarning(plan.branch) : undefined;
    const warningId = useId();
    const headingId = useId();
    const name = worktree.branch || worktree.head ? worktreeLabel(worktree) : '';
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
                    {plan.kind === 'record'
                        ? `Remove worktree record ${name}`
                        : `Remove worktree${name ? ` ${name}` : ''}`}
                </Text>
                <PathText path={worktree.path} variant="sm" color="secondary" />
            </Box>

            {checking && (
                <Text role="status" color="secondary">
                    Checking worktree and chats…
                </Text>
            )}
            {!chatsKnown && checking && <Text color="secondary">Checking linked chats…</Text>}
            {changed && <Risk>The worktree or linked chats changed. Review your choices again</Risk>}
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
                            {partialChats ? `At least ${subject}` : subject} will be {result}
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
                                choice.chatsTouched = true;
                                choice.disposition = selected ? 'delete' : 'archive';
                                redraw(n => n + 1);
                            }}
                        >
                            {count === 1 ? 'Delete the chat permanently' : 'Delete the chats permanently'}
                        </Switch>
                    )}
                    <Show when={plan.branch}>
                        {branch => (
                            <Box gap="xl">
                                <Switch
                                    size="sm"
                                    isDisabled={pending}
                                    isSelected={deleteBranch}
                                    aria-label={`Delete the branch ${branch.name}`}
                                    aria-describedby={warning ? warningId : undefined}
                                    onChange={selected => {
                                        choice.branchTouched = true;
                                        choice.deleteBranch = selected;
                                        redraw(n => n + 1);
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
            {(failure || readFailure) && (
                <Alert color="danger" role="alert">
                    <AlertIcon>
                        <AttentionCircle />
                    </AlertIcon>
                    <AlertDescription>
                        {failure || readFailure} — close and reopen this dialog to try again
                    </AlertDescription>
                </Alert>
            )}
            <Button
                color="danger"
                fullWidth
                isDisabled={pending || !!failure || checking || !!readFailure}
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
    const [content, setContent] = useState<ReactNode>();
    const [failure, setFailure] = useState<string>();
    const [previewChats] = useState(() => {
        const state = target.root.projectState(target.projectId);
        if (!state || state.status !== 'ready') return undefined;
        try {
            return affectedChats(
                target.preview ?? { path: target.path, workspaceId: target.workspaceId, chats: [] },
                { chats: [...state.chats.values()], runs: [...state.runs.values()] },
                target.folderId
            );
        } catch {
            return undefined;
        }
    });
    const [choice] = useState<RemoveChoice>(() => ({
        deleteBranch:
            !!target.preview &&
            !target.preview.missing &&
            target.preview.changes === 0 &&
            !target.preview.submodules &&
            !!removalPlan(target.preview).branch?.selected,
        disposition: 'archive',
    }));
    useEffect(() => {
        let active = true;
        const { root, projectId, folderId } = target;
        async function read() {
            try {
                const { worktree, snapshot } = await readWorktree(target);
                if (!samePath(worktree.path, target.path))
                    throw new Error('The worktree location changed. Close and reopen this dialog');
                const chats = affectedChats(worktree, snapshot, folderId);
                const hint = worktree.main ? 'This is the project checkout' : (removeHint(worktree) ?? chats.blocker);
                if (hint) throw new Error(hint);
                const plan = removalPlan(worktree);
                const preview = target.preview;
                const identityChanged =
                    !!preview && (preview.path !== worktree.path || preview.workspaceId !== worktree.workspaceId);
                const branchChanged =
                    (!preview && target.previewLabel !== undefined && target.previewLabel !== worktree.branch) ||
                    (!!preview &&
                        (identityChanged ||
                            preview.headOid !== worktree.headOid ||
                            preview.branch !== worktree.branch ||
                            preview.head !== worktree.head ||
                            preview.base !== worktree.base ||
                            preview.merged !== worktree.merged ||
                            preview.missing !== worktree.missing ||
                            preview.changes !== worktree.changes ||
                            preview.submodules !== worktree.submodules));
                const chatsChanged =
                    identityChanged ||
                    (!!previewChats &&
                        (previewChats.outside !== chats.outside ||
                            previewChats.ids.size !== chats.ids.size ||
                            [...previewChats.ids].some(id => !chats.ids.has(id))));
                const changed = branchChanged || chatsChanged;
                if (!choice.branchTouched)
                    choice.deleteBranch =
                        !worktree.missing && worktree.changes === 0 && !worktree.submodules && !!plan.branch?.selected;
                else if (branchChanged) choice.deleteBranch = false;
                if (changed && (choice.branchTouched || choice.chatsTouched)) {
                    choice.deleteBranch = false;
                    choice.disposition = 'archive';
                }
                if (active)
                    setContent(
                        <RemoveMessage
                            worktree={worktree}
                            plan={plan}
                            choice={choice}
                            changed={changed}
                            count={chats.ids.size}
                            outside={chats.outside}
                            onConfirm={async () => {
                                const { deleteBranch, disposition } = choice;
                                if (deleteBranch && (!worktree.branch || !worktree.headOid)) {
                                    throw new Error('Could not verify the branch commit');
                                }
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
                                    ...(plan.branch &&
                                        deleteBranch &&
                                        worktree.headOid && {
                                            deleteBranch: true,
                                            expectedBranch: { name: plan.branch.name, commit: worktree.headOid },
                                        }),
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
    }, [target, choice, previewChats]);
    if (content) return content;
    return (
        <RemoveMessage
            worktree={target.preview ?? { path: target.path, branch: target.previewLabel, head: undefined }}
            plan={
                target.preview
                    ? removalPlan(target.preview)
                    : { kind: 'plain', title: '', confirmLabel: 'Remove worktree', notes: [], stranded: false }
            }
            choice={choice}
            count={previewChats?.ids.size ?? 0}
            outside={previewChats?.outside ?? 0}
            chatsKnown={!!previewChats}
            partialChats={!target.preview}
            checking={!failure}
            readFailure={failure}
            onConfirm={async () => {}}
        />
    );
}

const openTargets = new Set<string>();

/** Open immediately while reading current Git and chat state. */
export async function openRemoveWorktree(target: WorktreeTarget): Promise<void> {
    const key = `${target.projectId}\0${target.folderId}\0${target.path
        .replace(/[\\/]+$/, '')
        .replaceAll('\\', '/')
        .toLowerCase()}`;
    if (openTargets.has(key)) return;
    openTargets.add(key);
    Modal.create({
        onClose: () => openTargets.delete(key),
        width: 440,
        zIndex: 101100,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: false,
        component: <ReadRemoval target={target} />,
    });
}
