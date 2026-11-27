import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { DiffStat } from '@clowdy/components/DiffStat';
import { For } from '@clowdy/components/For';
import { GridList, GridListItem, Menu, MenuItem } from '@clowdy/components/List';
import { PathText } from '@clowdy/components/PathText';
import { Popover, useContextMenu } from '@clowdy/components/Popover';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Spinner } from '@clowdy/components/Spinner';
import { SplitButton, type SplitButtonProps } from '@clowdy/components/SplitButton';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { AiStar, Refresh, Undo } from '@clowdy/icons/14';
import { commitMessageAgent, writesCommitMessages } from '@clowdy/protocol';
import { type MouseEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from 'react';

import { useAgents, useProjectUi, useRootStore } from '../../stores';
import { appendTextIntoComposer } from '../chats/composerBridge';
import { PathMenu, placeTarget } from '../openWith';
import { ChangeKindGlyph } from './ChangeKindGlyph';
import styles from './CommitBox.module.css';
import { commitDraftOf } from './CommitDraft';
import { commitLabel, commitTarget, isFetchFirst, SYNC_WORDS } from './changesActions';
import { confirmAbortMerge } from './confirmAbortMerge';
import { openDiscardDialog } from './DiscardDialog';
import { discardChanges } from './discardChanges';
import { discardableFiles } from './discardRules';
import { gitFactsOf } from './gitFacts';
import { useRemoteActions } from './useRemoteActions';

import type { GitChangedFile, GitStatusEntry } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { PressEvent } from 'react-aria-components';
import type { Place } from '../sidePanel/currentPlace';
import type { CommitDraft } from './CommitDraft';
import type { PlaceChanges } from './PlaceChanges';
import type { RemoteActions } from './RemoteActions';

/**
 * Shows Git's error and its hint. If origin moved between fetch and push, Retry Sync starts the whole sync again.
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
            {failure.what === 'sync' && isFetchFirst(failure.message) && (
                <Button
                    variant="bordered"
                    color="secondary"
                    size="xs"
                    className={styles.fetch}
                    isDisabled={draft.model.facts.switching}
                    isPending={remote.isPending('sync')}
                    spinnerPlacement="start"
                    onPress={() => draft.retrySync()}
                >
                    Retry Sync
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
    return (
        <GridListItem
            id={file.path}
            textValue={file.path}
            isDisabled={draft.writing}
            icon={
                mergeGroup === undefined ? (
                    <Checkbox
                        size="sm"
                        isSelected={draft.isTicked(file.path)}
                        isDisabled={draft.writing}
                        aria-label={file.path}
                        onChange={on => draft.setTicked(file.path, on)}
                    />
                ) : undefined
            }
            endAffix={
                file.additions !== undefined && file.deletions !== undefined ? (
                    <DiffStat added={file.additions} removed={file.deletions} className={styles.counts} />
                ) : undefined
            }
        >
            <Text slot="label" className={styles.fileName}>
                <ChangeKindGlyph kind={file.kind} />
                <PathText path={file.path} />
            </Text>
        </GridListItem>
    );
}

/**
 * The checklist of the files a commit takes. A right-click on a row (or the menu key on it) opens the menu of its path (`PathMenu`: Open in Files, the copies of the path, `Open in…`),
 * with `Discard changes…` at its end for a file whose uncommitted changes can be discarded.
 */
function CommitFileList({
    files,
    place,
    draft,
    mergeGroup,
}: {
    files: readonly CommitFile[];
    place: Place;
    draft: CommitDraft;
    mergeGroup?: 'conflicts' | 'staged';
}) {
    const { model } = draft;
    const { transport } = useRootStore();
    const contextMenu = useContextMenu();
    const [menuPath, setMenuPath] = useState<string>();
    const { close } = contextMenu;
    // This checklist always represents uncommitted files, regardless of the diff's scope or the checkboxes.
    const discardable =
        draft.writing || model.facts.switching || mergeGroup === 'conflicts'
            ? undefined
            : discardableFiles('uncommitted', model.uncommitted);
    const menuFile = menuPath ? files.find(file => file.path === menuPath) : undefined;
    const discardFile = menuFile && discardable?.get(menuFile.path);

    useEffect(() => () => close(), [close, model]);
    useEffect(() => {
        if (contextMenu.isOpen && !menuFile) close();
    }, [contextMenu.isOpen, menuFile, close]);

    const selectMenuFile = (row: Element | null) => {
        const path = row?.getAttribute('data-key');
        if (!path || !files.some(file => file.path === path)) return false;

        setMenuPath(path);
        return true;
    };

    const openMenu = (event: MouseEvent) => {
        if (selectMenuFile((event.target as Element).closest('[role="row"][data-key]')))
            contextMenu.areaProps.onContextMenu(event);
    };

    const openMenuFromKey = (event: ReactKeyboardEvent) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;

        const row = (event.target as Element).closest('[role="row"][data-key]');
        if (!row || !event.currentTarget.contains(row) || !selectMenuFile(row)) return;

        event.preventDefault();
        event.stopPropagation();
        const rect = row.getBoundingClientRect();
        contextMenu.openAt(rect.left, rect.bottom);
    };

    const discard = () => {
        if (!discardFile) return;
        openDiscardDialog({
            file: discardFile,
            discard: () => discardChanges(model, transport, discardFile.path),
        });
    };

    if (files.length === 0) return null;

    return (
        <div onContextMenu={openMenu} onKeyDown={openMenuFromKey}>
            <GridList
                aria-label={mergeGroup === 'conflicts' ? 'Conflicting files' : 'Files to commit'}
                size="sm"
                onAction={key => {
                    const path = String(key);

                    // A press on the row opens the file's diff; its tick is the checkbox's own.
                    if (mergeGroup === undefined) model.showFile(path);
                    else model.showUncommittedFile(path);
                }}
            >
                <For each={[...files]}>
                    {file => <CommitFileRow key={file.path} file={file} draft={draft} mergeGroup={mergeGroup} />}
                </For>
            </GridList>
            {contextMenu.isOpen && menuFile && (
                <Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs">
                    <PathMenu
                        target={placeTarget(model.facts.key.projectId, place, menuFile.path)}
                        expectGone={menuFile.kind === 'deleted'}
                        extra={
                            discardFile
                                ? [
                                      {
                                          id: 'discard',
                                          label: 'Discard changes…',
                                          icon: <Undo aria-hidden="true" />,
                                          isDanger: true,
                                          run: discard,
                                      },
                                  ]
                                : undefined
                        }
                        onClose={close}
                    />
                </Popover>
            )}
        </div>
    );
}

function ConflictActions({ writing, remote }: { writing: boolean; remote: RemoteActions }) {
    const ui = useProjectUi();

    const ask = () => {
        if (appendTextIntoComposer('Resolve the merge conflicts')) ui.showChat();
    };

    return (
        <div className={styles.conflictActions}>
            <Button
                variant="ghost"
                color="primary"
                size="xs"
                fullWidth
                aria-label="Ask agent to resolve conflicts"
                onPress={ask}
            >
                <AiStar aria-hidden="true" />
                Ask agent
            </Button>
            <Button
                variant="bordered"
                color="secondary"
                size="xs"
                fullWidth
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

function CommitSectionHeading({
    label,
    count,
    leading,
}: {
    label: string;
    count?: string | number;
    leading?: ReactNode;
}) {
    return (
        <div className={styles.header}>
            {leading}
            <Text as="h3" variant="xs" weight="medium" color="secondary" truncate>
                {label}
            </Text>
            {count !== undefined && (
                <Text variant="xs" color="secondary" className={styles.count}>
                    {count}
                </Text>
            )}
        </div>
    );
}

/**
 * The sidebar's commit checklist and message. Cmd or Ctrl and Enter uses the same action as the button.
 * Shift or the menu offers the other action for this commit.
 * A clean checkout still has a message field and a disabled commit button.
 */
export function CommitBox({ model, place }: { model: PlaceChanges; place: Place }) {
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

    if (model.isRepository === false || (!draft.known && !merging && !draft.rebasing)) return null;

    const { files, failure } = draft;
    const mergeFiles = mergeStatus ? mergeChecklist(mergeStatus.entries, files) : undefined;
    const commitFiles = mergeFiles?.staged ?? files;
    const conflicts = merging?.conflicts ?? 0;
    const generating = draft.busy === 'generate';
    const generateLabel = generating ? 'Stop generating commit message' : 'Generate commit message';
    const hasFiles = commitFiles.length > 0;
    const ticked = mergeFiles ? commitFiles.length : draft.ticked.length;
    const noStagedFiles = mergeStatus !== undefined && !hasFiles && !mergeStatus.truncated;
    const heading = mergeFiles
        ? noStagedFiles
            ? 'No staged files'
            : 'Files to commit'
        : hasFiles
          ? 'Commit'
          : 'No changed files';
    const count = hasFiles ? (mergeFiles ? commitFiles.length : `${ticked} of ${commitFiles.length}`) : undefined;
    const showConflicts = mergeFiles !== undefined && conflicts > 0;
    const truncationNotice = mergeStatus
        ? mergeStatus.truncated && `Showing merge files from the first ${mergeStatus.entries.length} changed files`
        : draft.truncated && `Showing the first ${files.length} files`;
    const hasChangesToCommit = hasFiles || merging !== undefined;
    const syncsByDefault = draft.syncsByDefault;
    const hasCommit = merging ? draft.concluding : ticked > 0;
    const commitAndSync = hasCommit && syncsByDefault !== shiftHeld;
    const target = commitTarget(status);
    const localLabel = merging ? 'Complete merge' : commitLabel(ticked);
    const localOnlyLabel = merging ? 'Complete merge locally' : 'Commit locally';
    const syncLabel = merging ? 'Complete merge and sync' : 'Commit and sync';
    const label =
        draft.busy === 'sync'
            ? draft.syncPhase
                ? SYNC_WORDS[draft.syncPhase]
                : 'Syncing…'
            : shiftHeld && hasCommit
              ? commitAndSync
                  ? syncLabel
                  : localOnlyLabel
              : localLabel;
    const alternateBlock = syncsByDefault ? undefined : draft.syncBlock;
    const reason = hasChangesToCommit
        ? (draft.commitReason ?? (commitAndSync && draft.busy === undefined ? draft.syncBlock : undefined))
        : undefined;
    const commit = (shift: boolean) => void draft.commit(shift ? !syncsByDefault : undefined);
    // The Commit button, alone while a merge has conflicts or with the menu of the other way to commit, where its label wraps at the narrowest sidebar.
    const commitProps = {
        color: 'contrast',
        size: 'sm',
        fullWidth: true,
        contentClassName: styles.commitContent,
        isDisabled: !(commitAndSync ? draft.canCommitAndSync : draft.canCommit),
        disabledReason: reason,
        isPending: draft.writing,
        tooltip:
            hasChangesToCommit && reason === undefined && !merging && !commitAndSync && target
                ? `Commit to ${target.name}`
                : undefined,
        tooltipPlacement: 'top',
        onPress: (event: PressEvent) => commit(event.shiftKey),
        children: label,
    } satisfies Omit<SplitButtonProps, 'menu' | 'menuLabel'>;

    return (
        <section className={styles.root} aria-label="Commit">
            {draft.rebasing && (
                <Text variant="xs" color="warning" role="status">
                    Rebase paused. Continue or abort the rebase in this checkout
                </Text>
            )}
            <CommitSectionHeading
                label={showConflicts ? 'Conflicts' : heading}
                count={
                    showConflicts
                        ? mergeFiles.conflicts.length < conflicts
                            ? `${mergeFiles.conflicts.length} of ${conflicts}`
                            : conflicts
                        : count
                }
                leading={
                    !mergeFiles &&
                    hasFiles && (
                        <Checkbox
                            size="sm"
                            isSelected={draft.allTicked}
                            isIndeterminate={!draft.allTicked && !draft.noneTicked}
                            isDisabled={draft.writing}
                            aria-label="Tick every file"
                            onChange={on => draft.setAll(on)}
                        />
                    )
                }
            />
            {showConflicts && <ConflictActions writing={draft.writing} remote={remote} />}

            {(hasFiles || conflicts > 0) && (
                <Scrollable className={styles.list} contentClass={styles.rows}>
                    {showConflicts && (
                        <>
                            <CommitFileList
                                files={mergeFiles.conflicts}
                                place={place}
                                draft={draft}
                                mergeGroup="conflicts"
                            />
                            <CommitSectionHeading label={heading} count={count} />
                        </>
                    )}
                    <CommitFileList
                        files={commitFiles}
                        place={place}
                        draft={draft}
                        mergeGroup={mergeFiles ? 'staged' : undefined}
                    />
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
                    ((!merging && !draft.rebasing) || generating) && (
                        <Button
                            variant="ghost"
                            color="primary"
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
                        commit(event.shiftKey);
                    }
                }}
            />

            {!merging || draft.concluding ? (
                <SplitButton
                    {...commitProps}
                    wrap
                    menuLabel="More ways to commit"
                    menuTooltip="More ways to commit"
                    isMenuDisabled={!draft.canCommit}
                    menuPlacement="top end"
                    menuWidth={220}
                    menu={
                        <Menu aria-label="Commit" size="sm" onAction={() => void draft.commit(!syncsByDefault)}>
                            <MenuItem
                                id={syncsByDefault ? 'local' : 'sync'}
                                icon={syncsByDefault ? undefined : <Refresh />}
                                text={syncsByDefault ? localOnlyLabel : syncLabel}
                                description={alternateBlock}
                                stacked={alternateBlock !== undefined}
                                isDisabled={alternateBlock !== undefined}
                            />
                        </Menu>
                    }
                />
            ) : (
                <Button {...commitProps} />
            )}

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
