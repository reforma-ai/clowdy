import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { For } from '@clowdy/components/For';
import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { AiStar, ArrowUp, ChevronDown } from '@clowdy/icons/14';
import { writesCommitMessages } from '@clowdy/protocol';
import { useEffect } from 'react';

import { useAgents, useRootStore } from '../../stores';
import styles from './CommitBox.module.css';
import { commitDraftOf } from './CommitDraft';
import { gitFactsOf } from './gitFacts';
import { CHANGE_KIND_VIEW, splitPath } from './gitSummary';
import { useRemoteActions } from './useRemoteActions';

import type { GitChangedFile } from '@clowdy/protocol';
import type { CommitDraft } from './CommitDraft';
import type { PlaceChanges } from './PlaceChanges';

/** What the line under the buttons says of a commit that was made: `Committed 1a2b3c4`, and, after Commit & Push, that its branch was sent too. */
function committedWords(draft: CommitDraft): string | undefined {
    const { committed, sent } = draft;

    if (!committed) return undefined;

    return `Committed ${committed.shortSha}${sent ? ` and ${sent === 'publish' ? 'published' : 'pushed'}` : ''}`;
}

/** What git or the daemon said when the box could not do what it was asked: git's own line, selectable, and the hint of the daemon under it when it has one. */
function FailureLines({ failure }: { failure: NonNullable<CommitDraft['failure']> }) {
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
        </div>
    );
}

/** One file of the commit: a tick, what happened to it, its name with its folder dimmed after it, and its lines. A press anywhere on the row ticks or unticks it. */
function CommitFileRow({ file, draft }: { file: GitChangedFile; draft: CommitDraft }) {
    const kind = CHANGE_KIND_VIEW[file.kind];
    const { folder, name } = splitPath(file.path);

    return (
        <Checkbox
            size="sm"
            className={styles.row}
            isSelected={draft.isTicked(file.path)}
            isDisabled={draft.writing}
            aria-label={file.path}
            onChange={on => draft.setTicked(file.path, on)}
        >
            <Text
                variant="xs"
                weight="medium"
                color={kind.color}
                className={styles.glyph}
                title={kind.label}
                aria-hidden="true"
            >
                {kind.glyph}
            </Text>
            <span className={styles.fileName} title={file.path}>
                <Text variant="xs" weight="medium" truncate className={styles.name}>
                    {name}
                </Text>
                {folder && (
                    <Text variant="xs" color="secondary" truncate className={styles.folderHint}>
                        {folder.slice(0, -1)}
                    </Text>
                )}
            </span>
            {file.additions !== undefined && file.deletions !== undefined && (
                <span className={styles.counts}>
                    <Text variant="xs" color="success">{`+${file.additions}`}</Text>
                    <Text variant="xs" color="danger">{`−${file.deletions}`}</Text>
                </span>
            )}
        </Checkbox>
    );
}

/**
 * The commit of the sidebar: the place's uncommitted files as a checklist (all ticked at first, new files included), the message and the buttons. It is there whichever scope the tab
 * shows, since what is committed is what is not committed yet, and the list inside it is its own: the sidebar's `Changed files` is the scope's list for finding a card, this one is for
 * choosing what goes in. Generate is offered only while an agent that the person turned `Commit messages` on for is signed in (`writesCommitMessages` of the agents the app already
 * knows; the daemon decides again when it is asked), and writes only into an empty box or over what it wrote itself. Commit is the one filled primary action of the place; Cmd or Ctrl and
 * Enter in the box does the same. What git or the agent said is shown as it said it, and the box is as it was. Beside Commit is a menu with **Commit & Push**: it commits as Commit does, then sends the
 * branch (a push, or its publishing when it is not on origin); the commit stands whatever the push comes to, the box is clear, and a push that failed is said with it (`Committed 1a2b3c4, push failed:
 * <git's line>`), the sidebar's menu offering Push again. The entry is off, with the reason under it, where the push after the commit would not be taken (no origin, a detached HEAD, a branch
 * that is behind or has diverged).
 */
export function CommitBox({ model }: { model: PlaceChanges }) {
    const root = useRootStore();
    const { agents } = useAgents();
    const remote = useRemoteActions(model.facts);
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

    // The list is read for each round of the facts, as the scope's list is; a scope that is the uncommitted one is read by the tab itself.
    useEffect(() => model.syncUncommitted(generation), [model, generation, scope]);
    // Files that went are forgotten, so one that comes back is ticked again.
    useEffect(() => draft.reconcile(), [draft, names]);

    if (model.isRepository === false || !draft.known) return null;

    const { files, failure, committed } = draft;
    const ticked = draft.ticked.length;
    const busy = draft.busy !== undefined;

    if (files.length === 0) {
        // Everything was committed: what is left to say is the commit, or why the push after it failed.
        return (
            <section className={styles.root} aria-label="Commit">
                {failure ? (
                    <FailureLines failure={failure} />
                ) : (
                    <Text variant="xs" color="secondary" role="status">
                        {committed ? committedWords(draft) : 'Nothing to commit'}
                    </Text>
                )}
            </section>
        );
    }

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
                <For each={[...files]}>{file => <CommitFileRow key={file.path} file={file} draft={draft} />}</For>
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
                    <Button
                        color="primary"
                        size="sm"
                        className={styles.commit}
                        isDisabled={!draft.canCommit}
                        isPending={draft.writing}
                        onPress={() => void draft.commit()}
                    >
                        Commit
                    </Button>
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

            {failure && <FailureLines failure={failure} />}
            {!failure && !busy && committed && (
                <Text variant="xs" color="secondary" role="status">
                    {committedWords(draft)}
                </Text>
            )}
        </section>
    );
}
