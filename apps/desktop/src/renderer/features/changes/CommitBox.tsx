import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { For } from '@clowdy/components/For';
import { GridList, GridListItem, Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { AiStar, ArrowUp, ChevronDown } from '@clowdy/icons/14';
import { writesCommitMessages } from '@clowdy/protocol';
import { useEffect, useState } from 'react';

import { Unavailable } from '../../shared/Unavailable';
import { useAgents, useRootStore } from '../../stores';
import styles from './CommitBox.module.css';
import { commitDraftOf } from './CommitDraft';
import { commitLabel, commitTarget, isFetchFirst } from './changesActions';
import { gitFactsOf } from './gitFacts';
import { CHANGE_KIND_VIEW, splitPath } from './gitSummary';
import { useRemoteActions } from './useRemoteActions';

import type { GitChangedFile } from '@clowdy/protocol';
import type { CommitDraft } from './CommitDraft';
import type { PlaceChanges } from './PlaceChanges';
import type { RemoteActions } from './RemoteActions';

/** What the line under the buttons says of a commit that was made: `Committed 1a2b3c4`, and, after Commit & Push, that its branch was sent too. */
function committedWords(draft: CommitDraft): string | undefined {
    const { committed, sent } = draft;

    if (!committed) return undefined;

    return `Committed ${committed.shortSha}${sent ? ` and ${sent === 'publish' ? 'published' : 'pushed'}` : ''}`;
}

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

/** One file in the commit checklist. Press the row or its checkbox to change the selection. */
function CommitFileRow({ file, draft }: { file: GitChangedFile; draft: CommitDraft }) {
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
                    isSelected={draft.isTicked(file.path)}
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

/**
 * The sidebar's commit checklist and message. Cmd or Ctrl and Enter makes a local commit.
 * Hold Shift on the button or use its menu to commit and then push or publish the branch.
 * Commit results and errors stay visible after the form empties.
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
    const canWrite = agents.some(writesCommitMessages);
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

    if (model.isRepository === false || !draft.known) return null;

    const { files, failure, committed } = draft;
    const ticked = draft.ticked.length;
    const busy = draft.busy !== undefined;

    const feedback = failure ? (
        <FailureLines failure={failure} draft={draft} remote={remote} />
    ) : !busy && committed ? (
        <Text variant="xs" color="secondary" role="status">
            {committedWords(draft)}
        </Text>
    ) : null;

    if (files.length === 0 && !draft.concluding) {
        return (
            feedback && (
                <section className={styles.root} aria-label="Commit">
                    {feedback}
                </section>
            )
        );
    }

    const target = commitTarget(model.facts.status.value);
    const label = shiftHeld ? 'Commit & Push' : draft.concluding ? 'Commit merge' : commitLabel(ticked);
    const reason = draft.commitReason ?? (shiftHeld && !busy ? draft.pushBlock : undefined);

    return (
        <section className={styles.root} aria-label="Commit">
            <div className={styles.header}>
                <Checkbox
                    size="sm"
                    isSelected={draft.allTicked}
                    isIndeterminate={!draft.allTicked && !draft.noneTicked}
                    isDisabled={draft.writing}
                    aria-label="Tick every file"
                    onChange={on => draft.setAll(on)}
                />
                <Text variant="xs" weight="medium" color="secondary" truncate>
                    Commit
                </Text>
                <Text variant="xs" color="secondary" className={styles.count}>{`${ticked} of ${files.length}`}</Text>
            </div>

            <Scrollable className={styles.list} contentClass={styles.rows}>
                <GridList
                    aria-label="Files to commit"
                    size="sm"
                    onAction={key => draft.setTicked(String(key), !draft.isTicked(String(key)))}
                >
                    <For each={[...files]}>{file => <CommitFileRow key={file.path} file={file} draft={draft} />}</For>
                </GridList>
            </Scrollable>
            {draft.truncated && <Text variant="xs" color="secondary">{`Showing the first ${files.length} files`}</Text>}

            <Textarea
                variant="bordered"
                size="sm"
                rows={3}
                isResizable={false}
                aria-label="Commit message"
                placeholder={draft.busy === 'generate' ? 'Writing the message' : 'Message'}
                value={draft.message}
                isReadOnly={draft.busy !== undefined}
                className={styles.message}
                onChange={text => draft.setMessage(text)}
                onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void draft.commit();
                    }
                }}
            />

            <div className={styles.actions}>
                {canWrite && (
                    <Button
                        variant="bordered"
                        size="sm"
                        className={styles.generate}
                        isDisabled={!draft.canGenerate}
                        isPending={draft.busy === 'generate'}
                        spinnerPlacement="start"
                        tooltip={draft.generateBlock}
                        tooltipPlacement="top"
                        onPress={() => void draft.generate()}
                    >
                        <AiStar aria-hidden="true" />
                        Generate
                    </Button>
                )}
                {/* Commit and its menu wrap together, so the menu's button is never left alone on a line. */}
                <div className={styles.commitGroup}>
                    <Unavailable label={label} hint={reason} className={styles.commitHost}>
                        <Button
                            color="contrast"
                            size="sm"
                            className={styles.commit}
                            contentClassName={styles.commitContent}
                            isDisabled={!(shiftHeld ? draft.canCommitAndPush : draft.canCommit)}
                            isPending={draft.writing}
                            tooltip={
                                reason === undefined && !shiftHeld && target ? `Commit to ${target.name}` : undefined
                            }
                            tooltipPlacement="top"
                            onPress={event => void draft.commit(shiftHeld && event.shiftKey)}
                        >
                            {label}
                        </Button>
                    </Unavailable>
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
                </div>
            </div>

            {/* Several chats share a place, so a commit that goes straight to the branch the work is compared with is said before it is made. */}
            {target?.onBase && (
                <Text
                    variant="xs"
                    color="secondary"
                    role="note"
                >{`Committing to ${target.name}, the base branch`}</Text>
            )}
            {feedback}
        </section>
    );
}
