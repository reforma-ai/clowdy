import { Button } from '@clowdy/components/Button';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { Close } from '@clowdy/icons/14';
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
} from '@clowdy/protocol';
import type { RemoteActions } from './RemoteActions';

export const MERGE_LABELS = { from: 'Merge from branch…', into: 'Merge into branch…' } as const;

type MergeDirection = GitBranchMergeSelection['direction'];
type MergeOutcome = Exclude<GitBranchMergeResult, GitBranchMergePreview>;
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
};

function FailureText({ failure }: { failure: Failure }) {
    return (
        <div className={styles.error} role="alert">
            <Text color="danger" select="text">
                {failure.message}
            </Text>
            {failure.hint && (
                <Text color="secondary" select="text">
                    {failure.hint}
                </Text>
            )}
        </div>
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

    const pick = async (id: string) => {
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
            });

            if (response.state !== 'preview') throw new Error("Couldn't compare the branches");
            if (round === previewRound.current) setPreview(response);
        } catch (error) {
            if (round === previewRound.current) setFailure(failureOf(error));
        }
    };

    const run = async (request: MergeAction) => {
        if (pending) return;

        setPending(request.action);
        setFailure(undefined);

        try {
            const response = await transport.branchMergeGit(projectId, placeRef(placeKey), request);

            if (response.state === 'preview') throw new Error("Couldn't apply the branch action");
            setResult(response);
        } catch (error) {
            if (request.action === 'merge') setPreview(undefined);
            setFailure(failureOf(error));
        } finally {
            gitFactsOf(transport).refreshFolder(placeKey);
            setPending(undefined);
        }
    };

    const merge = () => {
        if (!selection || !preview || preview.mode === 'up-to-date') return;

        void run({
            action: 'merge',
            ...selection,
            sourceCommit: preview.sourceCommit,
            targetCommit: preview.targetCommit,
        });
    };

    const source = preview?.source ?? (direction === 'from' ? (choice?.label ?? '…') : current);
    const target = preview?.target ?? (direction === 'into' ? (choice?.label ?? '…') : current);
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
            <div className={styles.heading}>
                <Text id={headingId} as="h2" variant="heading-3">
                    {`Merge ${source} to ${target}`}
                </Text>
                <Button
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
            </div>
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
                <Text color="secondary" role="status">
                    Comparing branches…
                </Text>
            )}
            {!result && preview && (
                <div className={styles.detail} role="status">
                    <Text variant="sm">
                        {preview.mode === 'up-to-date'
                            ? MODES[preview.mode]
                            : `${commitsWords(preview.commits)} · ${MODES[preview.mode]}`}
                    </Text>
                    {direction === 'into' && preview.targetPath && (
                        <Text color="secondary" variant="xs" title={preview.targetPath}>
                            {tildePath(preview.targetPath, homeFolder.path)}
                        </Text>
                    )}
                </div>
            )}
            {result?.state === 'conflicts' && (
                <div className={styles.detail} role="status">
                    <Text variant="sm" color="warning">
                        {result.conflicts === 0
                            ? `Finish the merge in ${result.target}`
                            : `${result.conflicts} ${result.conflicts === 1 ? 'conflict' : 'conflicts'} in ${result.target}`}
                    </Text>
                    <Text color="secondary" variant="xs" select="text">
                        {result.targetPath}
                    </Text>
                </div>
            )}
            {result?.state === 'done' && <Text variant="sm" role="status">{`Merged into ${result.target}`}</Text>}
            {result?.state === 'pushed' && (
                <Text variant="sm" role="status">{`Pushed ${result.target} to origin`}</Text>
            )}
            {result?.state === 'aborted' && (
                <Text variant="sm" role="status">{`Merge into ${result.target} aborted`}</Text>
            )}
            {failure && <FailureText failure={failure} />}
            <div className={styles.actions}>
                {result?.state === 'conflicts' && (
                    <Button
                        size="sm"
                        variant="bordered"
                        isDisabled={isWorking}
                        isPending={pending === 'abort'}
                        onPress={() =>
                            confirmAbortMerge(() =>
                                run({
                                    action: 'abort',
                                    target: result.target,
                                    commit: result.commit,
                                    sourceCommit: result.sourceCommit,
                                })
                            )
                        }
                    >
                        Abort merge
                    </Button>
                )}
                <Button
                    size="sm"
                    variant="filled"
                    color="secondary"
                    isDisabled={isWorking}
                    onPress={() => modal.cancel()}
                >
                    {result ? 'Done' : 'Cancel'}
                </Button>
                {!result && choice && failure && (
                    <Button size="sm" variant="bordered" onPress={() => void pick(choice.id)}>
                        Refresh preview
                    </Button>
                )}
                {result?.state === 'done' && direction === 'into' && result.canPush && (
                    <Button
                        className={styles.action}
                        size="sm"
                        color="contrast"
                        isPending={pending === 'push'}
                        onPress={() => void run({ action: 'push', target: result.target, commit: result.commit })}
                    >
                        {`Push ${result.target}`}
                    </Button>
                )}
                {!result && (
                    <Button
                        className={styles.action}
                        size="sm"
                        color="contrast"
                        isDisabled={!preview || preview.mode === 'up-to-date'}
                        isPending={pending === 'merge'}
                        onPress={merge}
                    >
                        {preview || choice || direction === 'from' ? `Merge into ${target}` : 'Merge'}
                    </Button>
                )}
            </div>
        </div>
    );
}
