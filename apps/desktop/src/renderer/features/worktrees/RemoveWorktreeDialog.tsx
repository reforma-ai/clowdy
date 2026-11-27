import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Box } from '@clowdy/components/Box';
import { For } from '@clowdy/components/For';
import { ConfirmModalContent, openFormDialog } from '@clowdy/components/modals';
import { Show } from '@clowdy/components/Show';
import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle } from '@clowdy/icons/14';
import { errorMessage } from '@clowdy/lib';
import { useEffect, useId, useState } from 'react';

import { PathText } from '../../shared/PathText';
import { worktreeLabel } from '../agents/workspaceChoice';
import { worktreeKey } from '../agents/worktreeCards';
import {
    affectedChats,
    archiveConsequence,
    readRemoval,
    refreshWorktreeTarget,
    removeWorktree,
} from './worktreeActions';
import { branchWarning, deleteBranchByDefault, reconcileChoice, removalPlan, STRANDED_WARNING } from './worktreeView';

import type { Chat } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { RemovalRead, WorktreeTarget } from './worktreeActions';
import type { RemovalPlan, RemoveChoice } from './worktreeView';

type ShownWorktree = { path: string; branch?: string; head?: string };

/** The plan shown while a worktree the list did not describe is read. */
const READING_PLAN: RemovalPlan = {
    kind: 'plain',
    title: '',
    confirmLabel: 'Remove worktree',
    notes: [],
    stranded: false,
};

const REOPEN = 'close and reopen this dialog to try again';

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

function removeTitle(worktree: ShownWorktree, plan: RemovalPlan): string {
    const name = worktree.branch || worktree.head ? worktreeLabel(worktree) : '';

    return plan.kind === 'record' ? `Remove worktree record ${name}` : `Remove worktree${name ? ` ${name}` : ''}`;
}

interface RemoveMessageProps {
    worktree: ShownWorktree;
    plan: RemovalPlan;
    choice: RemoveChoice;
    onChoice: (choice: RemoveChoice) => void;
    count: number;
    affected: readonly Chat[];
    outside: number;
    locked: boolean;
    checking: boolean;
    readFailure?: string;
    changed: boolean;
    chatsKnown: boolean;
    partialChats: boolean;
}

/**
 * The worktree's path and removal consequences. Deleting chats or the branch is an explicit choice; a detached HEAD has no branch to offer, and when its commits are not in
 * the base the dialog warns that commits may be lost.
 */
function RemoveMessage({
    worktree,
    plan,
    choice,
    onChoice,
    count,
    affected,
    outside,
    locked,
    checking,
    readFailure,
    changed,
    chatsKnown,
    partialChats,
}: RemoveMessageProps) {
    const { deleteBranch, disposition } = choice;
    const warning = deleteBranch && plan.branch ? branchWarning(plan.branch) : undefined;
    const warningId = useId();
    const subject = `${count} linked ${count === 1 ? 'chat' : 'chats'}`;

    return (
        <Box gap="xl">
            <PathText path={worktree.path} variant="sm" color="secondary" />

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
                        <>
                            <Text variant="md" color="secondary">
                                {partialChats ? `At least ${subject}` : subject}
                                {outside > 0 &&
                                    `, including ${outside} ${outside === 1 ? 'thread' : 'threads'} in other worktrees`}
                            </Text>
                            {disposition === 'delete' ? (
                                <Text color="warning">All linked chats will be permanently deleted</Text>
                            ) : (
                                <Text variant="sm" color="secondary">
                                    {archiveConsequence(affected)}
                                </Text>
                            )}
                            {affected.map(chat => (
                                <Text key={chat.id} variant="sm" color="secondary" wrap="anywhere">
                                    {chat.title} — {chat.archivedAt === undefined ? 'Not archived' : 'Already archived'}
                                </Text>
                            ))}
                        </>
                    )}
                </Box>
            )}

            {(count > 0 || plan.branch) && (
                <Box gap="md">
                    {count > 0 && (
                        <Switch
                            size="sm"
                            isDisabled={locked}
                            isSelected={disposition === 'delete'}
                            onChange={selected =>
                                onChoice({
                                    ...choice,
                                    chatsTouched: true,
                                    disposition: selected ? 'delete' : 'archive',
                                })
                            }
                        >
                            {count === 1 ? 'Delete the chat permanently' : 'Delete the chats permanently'}
                        </Switch>
                    )}
                    <Show when={plan.branch}>
                        {branch => (
                            <Box gap="xl">
                                <Switch
                                    size="sm"
                                    isDisabled={locked}
                                    isSelected={deleteBranch}
                                    aria-label={`Delete the branch ${branch.name}`}
                                    aria-describedby={warning ? warningId : undefined}
                                    onChange={selected =>
                                        onChoice({ ...choice, branchTouched: true, deleteBranch: selected })
                                    }
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
            <Show when={readFailure}>
                {text => (
                    <Alert color="danger" role="alert">
                        <AlertIcon>
                            <AttentionCircle />
                        </AlertIcon>
                        <AlertDescription>
                            {text} — {REOPEN}
                        </AlertDescription>
                    </Alert>
                )}
            </Show>
        </Box>
    );
}

/** The chats the store links to the worktree before Git is read, or `undefined` when the store cannot tell. */
function previewChatsOf(target: WorktreeTarget) {
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
}

/**
 * Opens on the list's preview and reads Git and the chats again; Remove stays off until that read is in. A refused removal leaves it off: the state it was confirmed
 * against is gone, so the dialog must be opened again.
 */
function ReadRemoval({ target }: { target: WorktreeTarget }) {
    const [previewChats] = useState(() => previewChatsOf(target));
    const [choice, setChoice] = useState<RemoveChoice>(() => ({
        deleteBranch: !!target.preview && deleteBranchByDefault(target.preview),
        disposition: 'archive',
    }));
    const [read, setRead] = useState<RemovalRead>();
    const [readFailure, setReadFailure] = useState<string>();
    const [phase, setPhase] = useState<'choosing' | 'removing' | 'refused'>('choosing');

    useEffect(() => {
        let active = true;
        readRemoval(target, { worktree: target.preview, label: target.previewLabel, chats: previewChats }).then(
            next => {
                if (!active) return;
                setChoice(current => reconcileChoice(current, next.worktree, next.drift));
                setRead(next);
            },
            error => {
                if (!active) return;
                setReadFailure(errorMessage(error, "Couldn't read the worktree"));
                void refreshWorktreeTarget(target).catch(() => undefined);
            }
        );
        return () => {
            active = false;
        };
    }, [target, previewChats]);

    const worktree = read?.worktree ?? target.preview ?? { path: target.path, branch: target.previewLabel };
    const plan = read?.plan ?? (target.preview ? removalPlan(target.preview) : READING_PLAN);
    const chats = read?.chats ?? previewChats;

    return (
        <ConfirmModalContent
            title={removeTitle(worktree, plan)}
            message={
                <RemoveMessage
                    worktree={worktree}
                    plan={plan}
                    choice={choice}
                    onChoice={setChoice}
                    count={chats?.ids.size ?? 0}
                    affected={chats?.affected ?? []}
                    outside={chats?.outside ?? 0}
                    locked={phase !== 'choosing'}
                    checking={!read && !readFailure}
                    readFailure={readFailure}
                    changed={!!read && (read.drift.branch || read.drift.chats)}
                    chatsKnown={!!chats}
                    partialChats={!read && !target.preview}
                />
            }
            confirmLabel={plan.confirmLabel}
            destructive
            // Cancel takes the focus, and Enter in the dialog's body does not remove: only a press on the red button does.
            initialFocus="cancel"
            errorIn="dialog"
            isConfirmDisabled={!read || phase === 'refused'}
            onConfirm={async () => {
                if (!read) return;
                setPhase('removing');
                try {
                    await removeWorktree(target, read, choice);
                } catch (error) {
                    setPhase('refused');
                    throw new Error(`${errorMessage(error, 'Something went wrong')} — ${REOPEN}`);
                }
            }}
        />
    );
}

const openTargets = new Set<string>();

/** Open immediately while reading current Git and chat state. */
export async function openRemoveWorktree(target: WorktreeTarget): Promise<void> {
    const key = `${target.projectId}\0${worktreeKey(target.folderId, target.path)}`;
    if (openTargets.has(key)) return;
    openTargets.add(key);
    openFormDialog({
        layer: 'confirm',
        role: 'alertdialog',
        closeButton: false,
        width: 440,
        onClose: () => openTargets.delete(key),
        component: <ReadRemoval target={target} />,
    });
}
