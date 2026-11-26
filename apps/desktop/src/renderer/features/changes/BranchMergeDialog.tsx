import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Popover } from '@clowdy/components/Popover';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { AttentionCircle, Check, ChevronDown, Close } from '@clowdy/icons/14';
import { errorMessage } from '@clowdy/lib';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { type Transport, TransportError } from '../../daemon/transport';
import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { PickerList, type PickerOption } from '../../shared/PickerPopover';
import styles from './BranchMergeDialog.module.css';
import { commitsWords, SYNC_WORDS } from './changesActions';
import { confirmAbortMerge } from './confirmAbortMerge';
import { type GitPlaceKey, gitFactsOf, placeRef } from './gitFacts';
import { sourceControlPreferences } from './sourceControlPreferences';

import type {
    GitBranches,
    GitBranchMergePreview,
    GitBranchMergeRequest,
    GitBranchMergeResult,
    GitBranchMergeSelection,
    GitBranchMergeStrategy,
    GitSyncProgress,
} from '@clowdy/protocol';
import type { RemoteActions } from './RemoteActions';

export const MERGE_LABELS = { from: 'Merge from branch…', into: 'Merge into branch…' } as const;

type MergeDirection = GitBranchMergeSelection['direction'];
type DialogStrategy = Exclude<GitBranchMergeStrategy, 'fast-forward-only'>;
type MergeOutcome =
    | Extract<GitBranchMergeResult, { state: 'conflicts' | 'done' }>
    | { state: 'sync-conflicts'; target: string; targetPath: string; conflicts: number };
type MergeAction =
    | Extract<GitBranchMergeRequest, { action: 'merge' | 'abort' }>
    | { action: 'sync'; target: string; commit: string };

interface MergeOptions {
    transport: Transport;
    remote: RemoteActions;
    placeKey: GitPlaceKey;
    current: string;
    direction: MergeDirection;
    hasOrigin: boolean;
    /** Opens the outgoing merge directly on the folder's checkout, using this name until its current branch is read. */
    checkoutBranch?: string;
}

interface MergeChoice extends PickerOption {
    branch: string;
    remote?: true;
}

const localChoice = (name: string): MergeChoice => ({ id: `refs/heads/${name}`, label: name, branch: name });

function choicesOf(listing: GitBranches | undefined, current: string, includeOrigin: boolean): MergeChoice[] {
    if (!listing?.isRepository) return [];

    const local = listing.local.filter(branch => branch.name !== current).map(({ name }) => localChoice(name));
    const origin = includeOrigin
        ? listing.remote.map(({ name }) => ({
              id: `refs/remotes/origin/${name}`,
              label: `origin/${name}`,
              branch: name,
              remote: true as const,
          }))
        : [];

    return [...local, ...origin];
}

interface Failure {
    message: string;
    hint?: string;
}

const failureOf = (error: unknown): Failure => ({
    message: errorMessage(error),
    ...(error instanceof TransportError && error.hint !== undefined && { hint: error.hint }),
});

const MODES: Record<
    Exclude<GitBranchMergePreview['mode'], 'up-to-date' | 'rebase'>,
    { preview: string; done: string }
> = {
    'fast-forward': {
        preview: 'Fast-forward without a merge commit',
        done: 'Fast-forwarded without a merge commit',
    },
    'merge-commit': { preview: 'Creates a merge commit', done: 'Created a merge commit' },
    squash: { preview: 'Creates one new commit', done: 'Created one new commit' },
};

function mergeSummary(
    { mode, commits, replayCommits = 0, target, source }: GitBranchMergePreview,
    done: boolean
): string {
    if (mode === 'rebase') {
        if (replayCommits > 0)
            return done
                ? `Replayed ${commitsWords(replayCommits)} onto ${source}`
                : `${commitsWords(replayCommits)} to replay`;

        return done ? `Fast-forwarded ${target} without replaying commits` : 'Fast-forward without replaying commits';
    }

    return done
        ? `${mode === 'squash' ? 'Squashed' : 'Merged'} ${commitsWords(commits)} into ${target}`
        : `${commitsWords(commits)} to merge`;
}

const STRATEGIES: Record<DialogStrategy, { label: string; description: string }> = {
    merge: {
        label: 'Merge',
        description: 'Join the branch histories, using a fast-forward when possible',
    },
    squash: { label: 'Squash and merge', description: 'Combine incoming changes into one new commit' },
    rebase: { label: 'Rebase', description: 'Replay the current branch’s commits on the selected branch' },
};

function mergeBlock(
    { source, target, targetPath, mode, fastForwardOnly, conflictCheck }: GitBranchMergePreview,
    direction: MergeDirection
): Failure | undefined {
    if (mode === 'up-to-date') return undefined;
    if (fastForwardOnly && mode === 'merge-commit')
        return { message: `Can't merge into ${target} because Git is configured to require a fast-forward` };
    if (direction === 'into' && !targetPath) return { message: `Check out ${target} before merging into it` };

    if (conflictCheck === 'conflicts')
        return {
            message: `Can't ${mode === 'squash' ? 'squash' : 'merge'} into ${target} because the branches conflict`,
            hint: `In a chat on ${target}, use Merge from branch to merge ${source} and resolve the conflicts`,
        };

    if ((mode === 'squash' || (direction === 'into' && mode === 'merge-commit')) && conflictCheck !== 'clean')
        return { message: "Couldn't check for merge conflicts" };
}

function FailureText({ failure }: { failure: Failure }) {
    return (
        <Alert color="danger">
            <AlertIcon>
                <AttentionCircle />
            </AlertIcon>
            <AlertDescription className="select-text">{failure.message}</AlertDescription>
            {failure.hint && (
                <Text variant="xs" color="secondary" select="text">
                    {failure.hint}
                </Text>
            )}
        </Alert>
    );
}

export function openBranchMergeDialog(options: MergeOptions): void {
    Modal.create({
        id: 'branch-merge',
        width: 440,
        shadow: true,
        handle: false,
        clickOut: false,
        closeButton: false,
        closeOnEscape: false,
        component: <BranchMergeDialog {...options} />,
    });
}

function BranchMergeDialog({
    transport,
    remote,
    placeKey,
    current,
    direction,
    hasOrigin,
    checkoutBranch,
}: MergeOptions) {
    const { modal } = useModalContext();
    const headingId = useId();
    const [listing, setListing] = useState<GitBranches>();
    const [checkoutChoice, setCheckoutChoice] = useState<MergeChoice>();
    const [fetchFailed, setFetchFailed] = useState<Failure>();
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<string>();
    const [strategy, setStrategy] = useState<DialogStrategy>('merge');
    const [preview, setPreview] = useState<GitBranchMergePreview>();
    const [pending, setPending] = useState<MergeAction['action']>();
    const [syncPhase, setSyncPhase] = useState<GitSyncProgress['phase']>();
    const [result, setResult] = useState<MergeOutcome>();
    const [failure, setFailure] = useState<Failure>();
    const previewRound = useRef(0);

    const fetchOrigin = direction === 'from' && hasOrigin;
    const autoSync = sourceControlPreferences.autoSync;
    const choices = useMemo(
        () => choicesOf(listing, current, fetchOrigin && !fetchFailed),
        [listing, current, fetchOrigin, fetchFailed]
    );
    const { projectId } = placeKey;
    const choice = checkoutBranch ? checkoutChoice : choices.find(candidate => candidate.id === selected);
    const selection = choice && {
        direction,
        current,
        branch: choice.branch,
        ...(choice.remote && { remote: true as const }),
        ...(strategy !== 'merge' && { strategy }),
    };

    const compare = useCallback(
        async (picked: MergeChoice, method: DialogStrategy) => {
            const round = ++previewRound.current;

            setPreview(undefined);
            setFailure(undefined);

            try {
                const response = await transport.branchMergeGit(projectId, placeRef(placeKey), {
                    action: 'preview',
                    direction,
                    current,
                    branch: picked.branch,
                    ...(picked.remote && { remote: true as const }),
                    ...(method !== 'merge' && { strategy: method }),
                });

                if (response.state !== 'preview') throw new Error("Couldn't compare the branches");
                if (
                    (method === 'squash' || method === 'rebase') &&
                    response.mode !== method &&
                    response.mode !== 'up-to-date'
                )
                    throw new Error(`Update Clowdy to use ${STRATEGIES[method].label}`);
                if (round === previewRound.current) setPreview(response);
            } catch (error) {
                if (round === previewRound.current) setFailure(failureOf(error));
            }
        },
        [transport, projectId, placeKey, direction, current]
    );

    useEffect(() => {
        let active = true;

        const load = async () => {
            const place = placeRef(placeKey);
            try {
                if (checkoutBranch) {
                    const projects = await transport.getProjectsInfo(projectId);
                    if (!active) return;
                    const folder = projects
                        .find(project => project.projectId === projectId)
                        ?.folders.find(folder => folder.folderId === placeKey.folderId);
                    if (!folder?.exists || folder.detached || !folder.branch || folder.branch === current)
                        throw new Error('The main checkout is no longer on a different branch');

                    const picked = localChoice(folder.branch);
                    setCheckoutChoice(picked);
                    await compare(picked, 'merge');
                    return;
                }

                if (fetchOrigin) {
                    const wasSyncing = remote.running !== undefined;
                    const fetching = remote.run('fetch', { report: false });

                    if (wasSyncing) {
                        // Local refs can be picked while the fetch waits for origin. The full list below retries if this read fails.
                        const local = await transport.getGitBranches(projectId, place).catch(() => undefined);
                        if (!active) return;
                        if (local?.isRepository) setListing({ ...local, remote: [] });
                    }

                    const fetch = await fetching;

                    if (!active) return;

                    if (!fetch.ok) setFetchFailed({ message: "Couldn't fetch origin", hint: fetch.failure.message });
                }

                const branches = await transport.getGitBranches(projectId, place);

                if (active) setListing(branches);
            } catch (error) {
                if (active) setFailure(failureOf(error));
            } finally {
                if (active) setLoading(false);
            }
        };

        void load();

        return () => {
            active = false;
            previewRound.current++;
        };
    }, [fetchOrigin, placeKey, projectId, remote, transport, checkoutBranch, current, compare]);

    const pick = (id: string) => {
        if (pending) return;

        const picked = choices.find(option => option.id === id);

        if (!picked) return;

        setSelected(id);
        void compare(picked, strategy);
    };

    const source = preview?.source ?? (direction === 'from' ? (choice?.label ?? '…') : current);
    const target = preview?.target ?? (direction === 'into' ? (choice?.label ?? checkoutBranch ?? '…') : current);
    const mergeMessage = (branch: string) =>
        strategy === 'rebase'
            ? `Rebased ${branch} onto ${source}`
            : strategy === 'squash'
              ? `Squashed into ${branch}`
              : `Merged into ${branch}`;

    const run = async (request: MergeAction) => {
        if (pending) return;

        let action = request.action;
        setPending(action);
        setFailure(undefined);

        const sync = async (branch: string, commit: string) => {
            action = 'sync';
            setPending(action);
            const synced = await transport.syncGit(
                projectId,
                placeRef(placeKey),
                { branch, commit, destination: true },
                progress => {
                    setSyncPhase(progress.phase);
                    if (progress.phase === 'push') {
                        setResult({ state: 'done', target: branch, commit: progress.commit, canPush: true });
                    }
                }
            );
            if (synced.state === 'conflicts') {
                setResult({
                    state: 'sync-conflicts',
                    target: synced.branch,
                    targetPath: synced.path,
                    conflicts: synced.conflicts,
                });
                return;
            }

            modal.cancel();
            toast.success({ message: synced.pushed ? `Pushed ${branch} to origin` : mergeMessage(branch) });
        };

        try {
            if (request.action === 'sync') {
                await sync(request.target, request.commit);
                return;
            }

            const response = await transport.branchMergeGit(projectId, placeRef(placeKey), request);

            switch (response.state) {
                case 'conflicts':
                    setResult(response);
                    return;

                case 'done':
                    if (response.canPush && (autoSync || direction === 'into')) {
                        setResult(response);
                        if (autoSync) await sync(response.target, response.commit);
                        return;
                    }
                    modal.cancel();
                    toast.success({ message: mergeMessage(response.target) });
                    return;

                case 'aborted':
                    modal.cancel();
                    toast.info({
                        message:
                            response.operation === 'rebase'
                                ? `Rebase of ${response.target} aborted`
                                : `Merge into ${response.target} aborted`,
                    });
                    return;

                default:
                    throw new Error("Couldn't apply the branch action");
            }
        } catch (error) {
            if (action === 'merge') setPreview(undefined);
            const cause = failureOf(error);
            setFailure(action === 'sync' ? { ...cause, message: `Sync failed: ${cause.message}` } : cause);
        } finally {
            gitFactsOf(transport).refreshFolder(placeKey);
            setPending(undefined);
            setSyncPhase(undefined);
        }
    };

    const blocked = preview ? mergeBlock(preview, direction) : undefined;
    const upToDate = preview?.mode === 'up-to-date';
    const canMerge = selection !== undefined && preview !== undefined && !upToDate && !blocked;

    const merge = () => {
        if (!selection || !preview || !canMerge) return;

        void run({
            action: 'merge',
            ...selection,
            sourceCommit: preview.sourceCommit,
            targetCommit: preview.targetCommit,
            expectedMode: preview.mode,
        });
    };

    const actionLabel = STRATEGIES[strategy].label;
    const actionStatus = !selection
        ? checkoutBranch
            ? loading
                ? 'Comparing branches…'
                : undefined
            : 'Select a branch'
        : upToDate
          ? 'Already up to date'
          : !preview && !failure
            ? 'Comparing branches…'
            : undefined;
    const done = result?.state === 'done';
    const isWorking = pending !== undefined;
    // What the footer has to offer: the merge itself, or after it Abort for a merge or rebase that stopped on conflicts and Sync for one that is done. Nothing else is left to press.
    const hasActions =
        !result ||
        (result.state === 'conflicts' && (result.conflicts > 0 || result.operation === 'rebase')) ||
        result.state === 'done';
    const modeDisabled = !selection || upToDate || (!preview && !failure);
    // The mode menu is part of the merge button alone: while the merge and the sync after it run, one full-width button carries the spinner, so nothing is dimmed, hidden or resized halfway.
    const showMode = !result && !isWorking;
    const syncLabel = syncPhase ? SYNC_WORDS[syncPhase] : 'Syncing…';
    const empty = loading ? (
        <Spinner
            size="xxs"
            className={styles.loading}
            aria-label={fetchOrigin ? 'Fetching branches from origin' : 'Loading branches'}
        />
    ) : choices.length === 0 ? (
        'No branches available'
    ) : undefined;

    return (
        <div
            className={styles.form}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            onKeyDown={event => {
                if (event.key === 'Escape' && !isWorking) {
                    event.stopPropagation();
                    modal.cancel();
                }
            }}
        >
            <Text id={headingId} as="h2" variant="heading-3" className={styles.heading}>
                {strategy === 'rebase'
                    ? `${done ? 'Rebased' : 'Rebase'} ${target} onto ${source}`
                    : `${done ? (strategy === 'squash' ? 'Squashed' : 'Merged') : 'Merge'} ${source} into ${target}`}
            </Text>
            <Button
                className={styles.close}
                size="sm"
                variant="filling"
                color="secondary"
                iconOnly
                aria-label="Close"
                isDisabled={isWorking}
                onPress={() => modal.cancel()}
            >
                <Close />
            </Button>
            {!result && !checkoutBranch && (loading || listing) && (
                <div inert={isWorking}>
                    <PickerList
                        options={choices}
                        aria-label={direction === 'from' ? 'Source branch' : 'Destination branch'}
                        selectedIds={selected ? [selected] : []}
                        placeholder="Filter branches"
                        empty={empty}
                        listClassName={styles.branches}
                        onPick={pick}
                    />
                </div>
            )}
            {!result && fetchFailed && <FailureText failure={fetchFailed} />}
            {(!result || done) && preview && preview.mode !== 'up-to-date' && (
                <div className={styles.detail} role="status">
                    <Text variant="sm">{mergeSummary(preview, done)}</Text>
                    {preview.mode !== 'rebase' && !blocked && (
                        <Text variant="sm" color="secondary">
                            {MODES[preview.mode][done ? 'done' : 'preview']}
                        </Text>
                    )}
                    {direction === 'into' && preview.targetPath && (
                        <Text color="secondary" variant="xs" title={preview.targetPath}>
                            {tildePath(preview.targetPath, homeFolder.path)}
                        </Text>
                    )}
                </div>
            )}
            {!result && blocked && <FailureText failure={blocked} />}
            {(result?.state === 'conflicts' || result?.state === 'sync-conflicts') && (
                <div className={styles.detail} role="status">
                    <Text variant="sm" color={result.conflicts > 0 ? 'warning' : undefined}>
                        {result.conflicts === 0
                            ? `${result.state === 'conflicts' && result.operation === 'rebase' ? 'Rebase paused' : 'Complete the merge'} in ${result.target}`
                            : `${result.conflicts} ${result.conflicts === 1 ? 'conflict' : 'conflicts'} in ${result.target}`}
                    </Text>
                    <Text color="secondary" variant="xs" select="text">
                        {result.targetPath}
                    </Text>
                    {result.state === 'sync-conflicts' && (
                        <Text color="secondary" variant="xs">
                            Resolve the conflicts in this checkout and complete the merge to resume sync
                        </Text>
                    )}
                    {result.state === 'conflicts' && result.operation === 'rebase' && (
                        <Text color="secondary" variant="xs">
                            {result.conflicts > 0
                                ? 'Resolve the conflicts and continue the rebase in this chat'
                                : 'Continue the rebase in this chat'}
                        </Text>
                    )}
                </div>
            )}
            {failure && <FailureText failure={failure} />}
            {hasActions && (
                <div className={styles.actions}>
                    {(!result || result.state === 'done') && (
                        <div className={styles.split} data-mode={showMode || undefined}>
                            {!result && (
                                <span className={styles.visuallyHidden} role="status">
                                    {selection ? actionStatus : undefined}
                                </span>
                            )}
                            <Button
                                size="md"
                                color="contrast"
                                className={styles.primary}
                                isDisabled={!result && !canMerge}
                                isPending={pending === 'merge' || pending === 'sync'}
                                onPress={
                                    result
                                        ? () =>
                                              void run({ action: 'sync', target: result.target, commit: result.commit })
                                        : merge
                                }
                            >
                                {result
                                    ? pending === 'sync'
                                        ? syncLabel
                                        : `Sync ${result.target}`
                                    : (actionStatus ?? actionLabel)}
                            </Button>
                            {showMode && (
                                <MenuTrigger>
                                    <Button
                                        size="md"
                                        color="contrast"
                                        iconOnly
                                        className={styles.mode}
                                        aria-label="Choose merge mode"
                                        isDisabled={modeDisabled}
                                    >
                                        <ChevronDown aria-hidden="true" />
                                    </Button>
                                    <Popover placement="top end" spacing="xs" width={300}>
                                        <Menu
                                            size="sm"
                                            aria-label="Merge mode"
                                            selectionMode="single"
                                            selectedKeys={[strategy]}
                                            disallowEmptySelection
                                            onAction={key => {
                                                const next = key as DialogStrategy;
                                                if (next === strategy) return;
                                                setStrategy(next);
                                                if (choice) void compare(choice, next);
                                            }}
                                        >
                                            {(Object.keys(STRATEGIES) as DialogStrategy[])
                                                .filter(id => direction === 'from' || id !== 'rebase')
                                                .map(id => (
                                                    <MenuItem
                                                        key={id}
                                                        id={id}
                                                        text={STRATEGIES[id].label}
                                                        description={STRATEGIES[id].description}
                                                        endAffix={
                                                            strategy === id ? <Check aria-hidden="true" /> : undefined
                                                        }
                                                        stacked
                                                    />
                                                ))}
                                        </Menu>
                                    </Popover>
                                </MenuTrigger>
                            )}
                        </div>
                    )}
                    {result?.state === 'conflicts' && (result.conflicts > 0 || result.operation === 'rebase') && (
                        <Button
                            size="md"
                            variant="bordered"
                            isDisabled={isWorking}
                            isPending={pending === 'abort'}
                            onPress={() =>
                                confirmAbortMerge(
                                    () =>
                                        run({
                                            action: 'abort',
                                            target: result.target,
                                            commit: result.commit,
                                            sourceCommit: result.sourceCommit,
                                            ...(result.operation && { operation: result.operation }),
                                        }),
                                    result.operation
                                )
                            }
                        >
                            {result.operation === 'rebase' ? 'Abort rebase' : 'Abort merge'}
                        </Button>
                    )}
                    {/* No Cancel or Done: the window's close button and Escape already close it. */}
                </div>
            )}
        </div>
    );
}
