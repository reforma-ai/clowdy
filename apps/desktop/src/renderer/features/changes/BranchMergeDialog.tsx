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
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { type Transport, TransportError } from '../../daemon/transport';
import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { PickerList, type PickerOption } from '../../shared/PickerPopover';
import styles from './BranchMergeDialog.module.css';
import { commitsWords } from './changesActions';
import { confirmAbortMerge } from './confirmAbortMerge';
import { type GitPlaceKey, gitFactsOf, placeRef } from './gitFacts';

import type {
    GitBranches,
    GitBranchMergePreview,
    GitBranchMergeRequest,
    GitBranchMergeResult,
    GitBranchMergeSelection,
    GitBranchMergeStrategy,
} from '@clowdy/protocol';
import type { RemoteActions } from './RemoteActions';

export const MERGE_LABELS = { from: 'Merge from branch…', into: 'Merge into branch…' } as const;

type MergeDirection = GitBranchMergeSelection['direction'];
type MergeOutcome = Extract<GitBranchMergeResult, { state: 'conflicts' | 'done' }>;
type MergeAction = Exclude<GitBranchMergeRequest, { action: 'preview' }>;

interface MergeOptions {
    transport: Transport;
    remote: RemoteActions;
    placeKey: GitPlaceKey;
    current: string;
    direction: MergeDirection;
    hasOrigin: boolean;
}

interface MergeChoice extends PickerOption {
    branch: string;
    remote?: true;
}

function choicesOf(listing: GitBranches | undefined, current: string, includeOrigin: boolean): MergeChoice[] {
    if (!listing?.isRepository) return [];

    const local = listing.local
        .filter(branch => branch.name !== current)
        .map(({ name }) => ({ id: `refs/heads/${name}`, label: name, branch: name }));
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

const MODES: Record<GitBranchMergePreview['mode'], string> = {
    'up-to-date': 'Already up to date',
    'fast-forward': 'Fast-forward',
    'merge-commit': 'Creates a merge commit',
    squash: 'Creates one commit',
    rebase: 'Rebase',
};

const STRATEGIES: Record<GitBranchMergeStrategy, { label: string; description: string }> = {
    merge: { label: 'Merge', description: 'Fast-forward or create a merge commit' },
    'fast-forward-only': { label: 'Fast-forward only', description: 'Only if the branches have not diverged' },
    squash: { label: 'Squash and merge', description: 'Combine changes into one commit' },
    rebase: { label: 'Rebase', description: 'Replay commits on the selected branch' },
};

function mergeBlock(
    { source, target, targetPath, mode, conflictCheck }: GitBranchMergePreview,
    strategy: GitBranchMergeStrategy,
    direction: MergeDirection
): Failure | undefined {
    if (mode === 'up-to-date') return undefined;
    if (strategy === 'fast-forward-only' && mode !== 'fast-forward')
        return { message: `Can't fast-forward ${target} because the branches have diverged` };
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

function BranchMergeDialog({ transport, remote, placeKey, current, direction, hasOrigin }: MergeOptions) {
    const { modal } = useModalContext();
    const headingId = useId();
    const [listing, setListing] = useState<GitBranches>();
    const [fetchFailed, setFetchFailed] = useState<Failure>();
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<string>();
    const [strategy, setStrategy] = useState<GitBranchMergeStrategy>('merge');
    const [preview, setPreview] = useState<GitBranchMergePreview>();
    const [pending, setPending] = useState<MergeAction['action']>();
    const [result, setResult] = useState<MergeOutcome>();
    const [failure, setFailure] = useState<Failure>();
    const previewRound = useRef(0);

    const fetchOrigin = direction === 'from' && hasOrigin;
    const choices = useMemo(
        () => choicesOf(listing, current, fetchOrigin && !fetchFailed),
        [listing, current, fetchOrigin, fetchFailed]
    );
    const { projectId } = placeKey;
    const choice = choices.find(candidate => candidate.id === selected);
    const selection = choice && {
        direction,
        current,
        branch: choice.branch,
        ...(choice.remote && { remote: true as const }),
        ...(strategy !== 'merge' && { strategy }),
    };

    useEffect(() => {
        let active = true;

        const load = async () => {
            try {
                if (fetchOrigin) {
                    const fetch = await remote.run('fetch', { report: false });

                    if (!active) return;

                    if (!fetch.ok) setFetchFailed({ message: "Couldn't fetch origin", hint: fetch.failure.message });
                }

                const branches = await transport.getGitBranches(projectId, placeRef(placeKey));

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
    }, [fetchOrigin, placeKey, projectId, remote, transport]);

    const pick = async (id: string, method = strategy) => {
        if (pending) return;

        const picked = choices.find(option => option.id === id);

        if (!picked) return;

        const round = ++previewRound.current;

        setSelected(id);
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
    };

    const source = preview?.source ?? (direction === 'from' ? (choice?.label ?? '…') : current);
    const target = preview?.target ?? (direction === 'into' ? (choice?.label ?? '…') : current);
    const mergeMessage = (branch: string) =>
        strategy === 'rebase'
            ? `Rebased ${branch} onto ${source}`
            : strategy === 'squash'
              ? `Squashed into ${branch}`
              : `Merged into ${branch}`;

    const run = async (request: MergeAction) => {
        if (pending) return;

        setPending(request.action);
        setFailure(undefined);

        try {
            const response = await transport.branchMergeGit(projectId, placeRef(placeKey), request);

            if (response.state === 'preview') throw new Error("Couldn't apply the branch action");
            const canPush = response.state === 'done' && direction === 'into' && response.canPush;
            if (response.state === 'conflicts' || canPush) {
                setResult(response);
                return;
            }

            modal.cancel();
            if (response.state === 'aborted') {
                toast.info({
                    message:
                        response.operation === 'rebase'
                            ? `Rebase of ${response.target} aborted`
                            : `Merge into ${response.target} aborted`,
                });
            } else {
                const message =
                    response.state === 'pushed' ? `Pushed ${response.target} to origin` : mergeMessage(response.target);
                toast.success({ message });
            }
        } catch (error) {
            if (request.action === 'merge') setPreview(undefined);
            setFailure(failureOf(error));
        } finally {
            gitFactsOf(transport).refreshFolder(placeKey);
            setPending(undefined);
        }
    };

    const blocked = preview ? mergeBlock(preview, strategy, direction) : undefined;

    const merge = () => {
        if (!selection || !preview || preview.mode === 'up-to-date' || blocked) return;

        void run({
            action: 'merge',
            ...selection,
            sourceCommit: preview.sourceCommit,
            targetCommit: preview.targetCommit,
        });
    };

    const actionLabel =
        strategy !== 'merge'
            ? STRATEGIES[strategy].label
            : preview?.mode === 'merge-commit'
              ? 'Create merge commit'
              : preview?.mode === 'fast-forward'
                ? 'Fast-forward'
                : 'Merge';
    const replay = preview?.replayCommits ?? 0;
    const isWorking = pending !== undefined;
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
                {`Merge ${source} to ${target}`}
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
            {!result && (loading || listing) && (
                <div inert={isWorking}>
                    <PickerList
                        options={choices}
                        aria-label={direction === 'from' ? 'Source branch' : 'Destination branch'}
                        selectedIds={selected ? [selected] : []}
                        placeholder="Filter branches"
                        empty={empty}
                        listClassName={styles.branches}
                        onPick={id => void pick(id)}
                    />
                </div>
            )}
            {!result && fetchFailed && <FailureText failure={fetchFailed} />}
            {!result && selected && !preview && !failure && (
                <Text variant="sm" color="secondary" role="status">
                    Comparing branches…
                </Text>
            )}
            {!result && preview && (
                <div className={styles.detail} role="status">
                    <Text variant="sm">
                        {preview.mode === 'rebase'
                            ? replay > 0
                                ? `Replay ${commitsWords(replay)} from ${target} on top of ${source}`
                                : `Fast-forward ${target} to ${source}`
                            : preview.mode === 'up-to-date'
                              ? MODES[preview.mode]
                              : commitsWords(preview.commits)}
                        {preview.mode !== 'up-to-date' &&
                            preview.mode !== 'rebase' &&
                            !blocked &&
                            ` · ${MODES[preview.mode]}`}
                    </Text>
                    {direction === 'into' && preview.targetPath && (
                        <Text color="secondary" variant="xs" title={preview.targetPath}>
                            {tildePath(preview.targetPath, homeFolder.path)}
                        </Text>
                    )}
                </div>
            )}
            {!result && blocked && <FailureText failure={blocked} />}
            {result?.state === 'conflicts' && (
                <div className={styles.detail} role="status">
                    <Text variant="sm" color={result.conflicts > 0 ? 'warning' : undefined}>
                        {result.conflicts === 0
                            ? `${result.operation === 'rebase' ? 'Rebase paused' : 'Complete the merge'} in ${result.target}`
                            : `${result.conflicts} ${result.conflicts === 1 ? 'conflict' : 'conflicts'} in ${result.target}`}
                    </Text>
                    <Text color="secondary" variant="xs" select="text">
                        {result.targetPath}
                    </Text>
                    {result.operation === 'rebase' && (
                        <Text color="secondary" variant="xs">
                            {result.conflicts > 0
                                ? 'Resolve the conflicts and continue the rebase in this chat'
                                : 'Continue the rebase in this chat'}
                        </Text>
                    )}
                </div>
            )}
            {result?.state === 'done' && (
                <Text variant="sm" role="status">
                    {mergeMessage(result.target)}
                </Text>
            )}
            {failure && <FailureText failure={failure} />}
            <div className={styles.actions}>
                {!result && (
                    <div className={styles.split}>
                        <Button
                            size="md"
                            color="contrast"
                            className={styles.primary}
                            isDisabled={!preview || preview.mode === 'up-to-date' || blocked !== undefined}
                            isPending={pending === 'merge'}
                            onPress={merge}
                        >
                            {actionLabel}
                        </Button>
                        <MenuTrigger>
                            <Button
                                size="md"
                                color="contrast"
                                iconOnly
                                className={styles.mode}
                                aria-label="Choose merge mode"
                                isDisabled={isWorking}
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
                                        const next = key as GitBranchMergeStrategy;
                                        if (next === strategy) return;
                                        setStrategy(next);
                                        if (selected) void pick(selected, next);
                                    }}
                                >
                                    {(Object.keys(STRATEGIES) as GitBranchMergeStrategy[]).map(id => (
                                        <MenuItem
                                            key={id}
                                            id={id}
                                            text={STRATEGIES[id].label}
                                            description={
                                                id === 'rebase' && direction === 'into'
                                                    ? 'Open a chat on the destination branch'
                                                    : STRATEGIES[id].description
                                            }
                                            endAffix={strategy === id ? <Check aria-hidden="true" /> : undefined}
                                            stacked
                                            isDisabled={id === 'rebase' && direction === 'into'}
                                        />
                                    ))}
                                </Menu>
                            </Popover>
                        </MenuTrigger>
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
                {result?.state === 'done' && (
                    <Button
                        size="md"
                        color="contrast"
                        isPending={pending === 'push'}
                        onPress={() => void run({ action: 'push', target: result.target, commit: result.commit })}
                    >
                        {`Push ${result.target}`}
                    </Button>
                )}
                <Button
                    size="md"
                    variant="filled"
                    color="secondary"
                    isDisabled={isWorking}
                    onPress={() => modal.cancel()}
                >
                    {result ? 'Done' : 'Cancel'}
                </Button>
            </div>
        </div>
    );
}
