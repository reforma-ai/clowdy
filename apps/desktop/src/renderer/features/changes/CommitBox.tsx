import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { For } from '@clowdy/components/For';
import { GridList, GridListItem, Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { AiStar, ArrowUp, ChevronDown } from '@clowdy/icons/14';
import { commitMessageAgent, writesCommitMessages } from '@clowdy/protocol';
import { useEffect, useState } from 'react';

import { Unavailable } from '../../shared/Unavailable';
import { useAgents, useProjectUi, useRootStore } from '../../stores';
import { quoteIntoComposer } from '../chats/composerBridge';
import styles from './CommitBox.module.css';
import { commitDraftOf } from './CommitDraft';
import { commitLabel, commitTarget, isFetchFirst } from './changesActions';
import { confirmAbortMerge } from './confirmAbortMerge';
import { gitFactsOf } from './gitFacts';
import { CHANGE_KIND_VIEW, splitPath } from './gitSummary';
import { useRemoteActions } from './useRemoteActions';

import type { GitChangedFile, GitStatusEntry } from '@clowdy/protocol';
import type { CommitDraft } from './CommitDraft';
import type { PlaceChanges } from './PlaceChanges';
import type { RemoteActions } from './RemoteActions';

/**
 * What git or the daemon said when the box could not do what it was asked: git's own line, selectable, and the hint of the daemon under it when it has one. A push that origin turned
 * down for commits the branch lacks (`Committed 1a2b3c4, push failed: ! [rejected] main -> main (fetch first)`) has a Fetch origin button beside the line, as GitHub Desktop's
 * `Newer Commits on Remote` has Fetch.
 */
function FailureLines({
    failure,
    draft,
    remote,
}: {
    failure: NonNullable<CommitDraft['failure']>;
    draft: CommitDraft;
    remote: RemoteActions;
}) {
    return (
        <div className={styles.failure} role="alert">
            <Text variant="xs" color="danger" select="text">
                {failure.message}
            </Text>
            {failure.hint && (
                <Text variant="xs" color="secondary" select="text">
                    {failure.hint}
                </Text>
            )}
            {failure.what === 'push' && isFetchFirst(failure.message) && (
                <Button
                    variant="bordered"
                    color="secondary"
                    size="xs"
                    className={styles.fetch}
                    isDisabled={remote.busy && remote.running !== 'fetch'}
                    isPending={remote.running === 'fetch'}
                    spinnerPlacement="start"
                    onPress={() => void draft.fetchAfterRejection()}
                >
                    Fetch origin
                </Button>
            )}
        </div>
    );
}

type CommitFile = Pick<GitChangedFile, 'path' | 'kind' | 'additions' | 'deletions'>;

function mergeChecklist(entries: readonly GitStatusEntry[], files: readonly GitChangedFile[]) {
    const diffs = new Map(files.map(file => [file.path, file]));
    const conflicts: CommitFile[] = [];
    const staged: CommitFile[] = [];

    for (const { path, staged: kind, unstaged } of entries) {
        if (unstaged === 'conflicted') {
            conflicts.push({ path, kind: 'conflicted' });
        } else if (kind !== undefined) {
            // The uncommitted diff counts worktree edits too. Only show counts for index-only changes.
            const diff = unstaged === undefined ? diffs.get(path) : undefined;
            staged.push({ ...diff, path, kind });
        }
    }

    return { conflicts, staged };
}

/** The same file row is used for selectable commits and for showing Git's merge index. */
function CommitFileRow({
    file,
    draft,
    mergeGroup,
}: {
    file: CommitFile;
    draft: CommitDraft;
    mergeGroup?: 'conflicts' | 'staged';
}) {
    const kind = CHANGE_KIND_VIEW[file.kind];
    const { folder, name } = splitPath(file.path);

    return (
        <GridListItem
            id={file.path}
            textValue={file.path}
            isDisabled={draft.writing}
            icon={
                <Checkbox
                    size="sm"
                    isSelected={mergeGroup === undefined ? draft.isTicked(file.path) : mergeGroup === 'staged'}
                    isReadOnly={mergeGroup !== undefined}
                    isDisabled={draft.writing}
                    aria-label={file.path}
                    onChange={on => draft.setTicked(file.path, on)}
                />
            }
            endAffix={
                file.additions !== undefined && file.deletions !== undefined ? (
                    <span className={styles.counts}>
                        <Text variant="sm" color="success">{`+${file.additions}`}</Text>
                        <Text variant="sm" color="danger">{`−${file.deletions}`}</Text>
                    </span>
                ) : undefined
            }
        >
            <Text slot="label" className={styles.fileName} title={file.path}>
                <Text weight="medium" color={kind.color} className={styles.glyph} title={kind.label} aria-hidden="true">
                    {kind.glyph}
                </Text>
                <Text weight="medium" truncate className={styles.name}>
                    {name}
                </Text>
                {folder && (
                    <Text color="secondary" truncate className={styles.folderHint}>
                        {folder.slice(0, -1)}
                    </Text>
                )}
            </Text>
        </GridListItem>
    );
}

function CommitFileList({
    files,
    draft,
    mergeGroup,
}: {
    files: readonly CommitFile[];
    draft: CommitDraft;
    mergeGroup?: 'conflicts' | 'staged';
}) {
    if (files.length === 0) return null;

    return (
        <GridList
            aria-label={mergeGroup === 'conflicts' ? 'Conflicting files' : 'Files to commit'}
            size="sm"
            onAction={key => {
                const path = String(key);

                if (mergeGroup === undefined) draft.setTicked(path, !draft.isTicked(path));
                else draft.model.showUncommittedFile(path);
            }}
        >
            <For each={[...files]}>
                {file => <CommitFileRow key={file.path} file={file} draft={draft} mergeGroup={mergeGroup} />}
            </For>
        </GridList>
    );
}

function ConflictActions({
    conflicts,
    writing,
    remote,
}: {
    conflicts: readonly CommitFile[];
    writing: boolean;
    remote: RemoteActions;
}) {
    const ui = useProjectUi();

    const ask = () => {
        const quote =
            conflicts.length === 0
                ? 'Resolve the merge conflicts'
                : `Resolve the merge conflicts in:\n${conflicts.map(({ path }) => `- \`${path}\``).join('\n')}`;

        if (quoteIntoComposer(quote)) ui.showChat();
    };

    return (
        <div className={styles.conflictActions}>
            <Button
                variant="filled"
                color="secondary"
                size="xs"
                aria-label="Ask agent to resolve conflicts"
                onPress={ask}
            >
                Ask agent
            </Button>
            <Button
                variant="filling"
                color="secondary"
                size="xs"
                isDisabled={writing || remote.busy}
                isPending={remote.running === 'abort'}
                onPress={() =>
                    confirmAbortMerge(async () => {
                        await remote.run('abort');
                    })
                }
            >
                Abort merge
            </Button>
        </div>
    );
}

/**
 * The sidebar's commit checklist and message. Cmd or Ctrl and Enter makes a local commit.
 * Hold Shift on the button or use its menu to commit and then push or publish the branch.
 * A clean checkout still has a message field and a disabled commit button.
 */
export function CommitBox({ model }: { model: PlaceChanges }) {
    const root = useRootStore();
    const { agents } = useAgents();
    const remote = useRemoteActions(model.facts);
    const [shiftHeld, setShiftHeld] = useState(false);
    const draft = commitDraftOf(
        model,
        root.transport,
        () => gitFactsOf(root.transport).refresh(model.facts.key),
        remote
    );
    const canWrite = writesCommitMessages(commitMessageAgent(agents));
    const { generation } = model.facts;
    const scope = model.effectiveScope;
    const names = draft.files.map(file => file.path).join('\0');

    useEffect(() => {
        const trackShift = (event: KeyboardEvent) => setShiftHeld(event.shiftKey);
        const releaseShift = () => setShiftHeld(false);

        window.addEventListener('keydown', trackShift, true);
        window.addEventListener('keyup', trackShift, true);
        window.addEventListener('blur', releaseShift);

        return () => {
            window.removeEventListener('keydown', trackShift, true);
            window.removeEventListener('keyup', trackShift, true);
            window.removeEventListener('blur', releaseShift);
        };
    }, []);

    // The list is read for each round of the facts, as the scope's list is; a scope that is the uncommitted one is read by the tab itself.
    useEffect(() => model.syncUncommitted(generation), [model, generation, scope]);
    // Files that went are forgotten, so one that comes back is ticked again.
    useEffect(() => draft.reconcile(), [draft, names]);
    // A resolved merge commits with the message git prepared, unless the person has written one.
    const mergeSubject = draft.mergeSubject;

    useEffect(() => {
        if (mergeSubject) draft.prefill(mergeSubject);
    }, [draft, mergeSubject]);

    const status = model.facts.status.value;
    const mergeStatus = status?.isRepository && status.merging ? status : undefined;
    const merging = mergeStatus?.merging;

    if (model.isRepository === false || (!draft.known && !merging)) return null;

    const { files, failure } = draft;
    const mergeFiles = mergeStatus ? mergeChecklist(mergeStatus.entries, files) : undefined;
    const commitFiles = mergeFiles?.staged ?? files;
    const conflicts = merging?.conflicts ?? 0;
    const generating = draft.busy === 'generate';
    const generateLabel = generating ? 'Stop generating commit message' : 'Generate commit message';
    const hasFiles = commitFiles.length > 0;
    const ticked = mergeFiles ? commitFiles.length : draft.ticked.length;
    const noStagedFiles = mergeStatus !== undefined && !hasFiles && !mergeStatus.truncated;
    const heading =
        !hasFiles && !mergeStatus ? '0 changed files' : noStagedFiles && conflicts === 0 ? 'No staged files' : 'Commit';
    const truncationNotice = mergeStatus
        ? mergeStatus.truncated && `Showing merge files from the first ${mergeStatus.entries.length} changed files`
        : draft.truncated && `Showing the first ${files.length} files`;
    const hasChangesToCommit = hasFiles || merging !== undefined;
    const commitAndPush = shiftHeld && hasFiles && !merging;
    const target = commitTarget(status);
    const label = merging ? 'Complete merge' : commitAndPush ? 'Commit & Push' : commitLabel(ticked);
    const reason = hasChangesToCommit
        ? (draft.commitReason ?? (commitAndPush && draft.busy === undefined ? draft.pushBlock : undefined))
        : undefined;

    return (
        <section className={styles.root} aria-label="Commit">
            <div className={styles.header}>
                <Checkbox
                    size="sm"
                    isSelected={mergeFiles ? hasFiles : draft.allTicked}
                    isIndeterminate={!mergeFiles && !draft.allTicked && !draft.noneTicked}
                    isReadOnly={mergeFiles !== undefined}
                    isDisabled={(!hasFiles && conflicts === 0) || draft.writing}
                    aria-label={mergeFiles ? 'Staged files' : 'Tick every file'}
                    onChange={on => draft.setAll(on)}
                />
                <Text variant="xs" weight="medium" color="secondary" truncate>
                    {heading}
                </Text>
                {hasFiles && (
                    <Text
                        variant="xs"
                        color="secondary"
                        className={styles.count}
                    >{`${ticked} of ${commitFiles.length}`}</Text>
                )}
            </div>

            {(hasFiles || conflicts > 0) && (
                <Scrollable className={styles.list} contentClass={styles.rows}>
                    {mergeFiles && conflicts > 0 && (
                        <>
                            <div className={styles.fileGroupHeading}>
                                <Text as="h3" variant="xs" weight="medium" color="secondary">
                                    Conflicts
                                </Text>
                                <Text variant="xs" color="secondary" className={styles.count}>
                                    {mergeFiles.conflicts.length < conflicts
                                        ? `${mergeFiles.conflicts.length} of ${conflicts}`
                                        : conflicts}
                                </Text>
                            </div>
                            <ConflictActions conflicts={mergeFiles.conflicts} writing={draft.writing} remote={remote} />
                            <CommitFileList files={mergeFiles.conflicts} draft={draft} mergeGroup="conflicts" />
                            <div className={styles.fileGroupHeading}>
                                <Text as="h3" variant="xs" weight="medium" color="secondary">
                                    {noStagedFiles ? 'No staged files' : 'Files to commit'}
                                </Text>
                            </div>
                        </>
                    )}
                    <CommitFileList files={commitFiles} draft={draft} mergeGroup={mergeFiles ? 'staged' : undefined} />
                </Scrollable>
            )}
            {truncationNotice && (
                <Text variant="xs" color="secondary">
                    {truncationNotice}
                </Text>
            )}

            <Textarea
                variant="bordered"
                size="sm"
                rows={3}
                isResizable={false}
                aria-label="Commit message"
                placeholder={generating ? 'Writing the message' : 'Message'}
                value={draft.message}
                isReadOnly={draft.busy !== undefined}
                alwaysShowEndAction
                endAction={
                    (!merging || generating) && (
                        <Button
                            variant="filling"
                            size="xs"
                            iconOnly
                            isDisabled={!generating && canWrite && !draft.canGenerate}
                            aria-label={generateLabel}
                            aria-haspopup={!generating && !canWrite ? 'dialog' : undefined}
                            tooltip={
                                generating || canWrite
                                    ? (!generating && draft.generateBlock) || generateLabel
                                    : 'Set up commit message generation'
                            }
                            tooltipPlacement="top"
                            onPress={() => {
                                if (generating) draft.stopGenerating();
                                else if (canWrite) void draft.generate();
                                else root.ui.openSettings('source-control');
                            }}
                        >
                            {generating ? (
                                <Spinner size="xxs" className={styles.generateProgress} aria-hidden="true" />
                            ) : (
                                <AiStar aria-hidden="true" />
                            )}
                        </Button>
                    )
                }
                onChange={text => draft.setMessage(text)}
                onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void draft.commit();
                    }
                }}
            />

            <div className={styles.commitGroup}>
                <Unavailable label={label} hint={reason} className={styles.commitHost}>
                    <Button
                        color="contrast"
                        size="sm"
                        className={styles.commit}
                        contentClassName={styles.commitContent}
                        isDisabled={!(commitAndPush ? draft.canCommitAndPush : draft.canCommit)}
                        isPending={draft.writing}
                        tooltip={
                            hasChangesToCommit && reason === undefined && !merging && !commitAndPush && target
                                ? `Commit to ${target.name}`
                                : undefined
                        }
                        tooltipPlacement="top"
                        onPress={event => void draft.commit(commitAndPush && event.shiftKey)}
                    >
                        {label}
                    </Button>
                </Unavailable>
                {!merging && (
                    <MenuTrigger>
                        <Button
                            variant="bordered"
                            size="sm"
                            iconOnly
                            className={styles.more}
                            isDisabled={!draft.canCommit}
                            aria-label="More ways to commit"
                            tooltip="More ways to commit"
                            tooltipPlacement="top"
                        >
                            <ChevronDown aria-hidden="true" />
                        </Button>
                        <Popover placement="top end" spacing="xs" width={220}>
                            <Menu aria-label="Commit" size="sm" onAction={() => void draft.commit(true)}>
                                <MenuItem
                                    id="commit-and-push"
                                    icon={<ArrowUp />}
                                    text="Commit & Push"
                                    description={draft.pushBlock}
                                    stacked={draft.pushBlock !== undefined}
                                    isDisabled={draft.pushBlock !== undefined}
                                />
                            </Menu>
                        </Popover>
                    </MenuTrigger>
                )}
            </div>

            {/* Several chats share a place, so a commit that goes straight to the branch the work is compared with is said before it is made. */}
            {hasChangesToCommit && target?.onBase && (
                <Text
                    variant="xs"
                    color="secondary"
                    role="note"
                >{`Committing to ${target.name}, the base branch`}</Text>
            )}
            {failure && <FailureLines failure={failure} draft={draft} remote={remote} />}
        </section>
    );
}
