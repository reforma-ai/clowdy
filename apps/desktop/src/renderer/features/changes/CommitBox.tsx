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
import { type ReactNode, useEffect } from 'react';

import { Unavailable } from '../../shared/Unavailable';
import { useAgents, useRootStore } from '../../stores';
import { actionIcon, chosenPrograms, openActions, openEffects, useOpenApps } from '../openWith';
import { placePath } from '../sidePanel/currentPlace';
import styles from './CommitBox.module.css';
import { commitDraftOf } from './CommitDraft';
import { createPullRequestOf } from './CreatePullRequest';
import {
    commitLabel,
    commitTarget,
    isFetchFirst,
    type NextStep,
    nextStep,
    type RemoteActionId,
} from './changesActions';
import { gitFactsOf } from './gitFacts';
import { CHANGE_KIND_VIEW, splitPath } from './gitSummary';
import { useRemoteActions } from './useRemoteActions';

import type { GitChangedFile, ProjectId } from '@clowdy/protocol';
import type { FolderGit, OpenAction, OpenTarget } from '../openWith';
import type { Place } from '../sidePanel/currentPlace';
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

/** A text that may break after each slash, where a branch name (`clowdy/ab12cd34`) is cut by the edge of a narrow button, and nowhere inside a word. It says the same words. */
function breakable(text: string): ReactNode[] {
    return text
        .split('/')
        .flatMap((part, index, parts) => [part, ...(index < parts.length - 1 ? ['/', <wbr key={index} />] : [])]);
}

/** The three quiet ways out of an empty box, in GitHub Desktop's order: the editor, the file manager, GitHub. */
const QUIET_ACTIONS: readonly string[] = ['editor', 'fileManager', 'github'];

/** What a quiet action says: the file manager `Show in Finder`, as GitHub Desktop has it, and the label the app uses elsewhere for the rest. */
const quietLabel = (action: OpenAction): string =>
    action.id === 'fileManager' && action.program ? `Show in ${action.program.app.name}` : action.label;

export interface CommitBoxProps {
    model: PlaceChanges;
    /** Where the window works: the folder's checkout or the chat's worktree, which the quiet actions of the empty box open. */
    place: Place;
    projectId: ProjectId;
    /** What git says of the place's folder (its `origin`), which the repository's page on GitHub and the compare page are built from. */
    git: FolderGit | undefined;
}

/**
 * The box when nothing is uncommitted, GitHub Desktop's `No local changes`: what the last commit came to (or why its push failed), then one suggested next step as the box's primary action
 * and three quiet ways out. The step is the first that applies (`nextStep`): `Publish your branch`, `Pull N commits from the origin remote`, `Push N commits to the origin remote`,
 * `Create a Pull Request from your current branch`, and none on the base branch or for a branch that has a pull request; a press does what the sync button does for the first three and
 * what Create PR does for the last (it opens GitHub's compare page). The quiet ways are the editor, the file manager and the repository on GitHub, which the open menu already runs
 * (`openActions`), for the place the window works in.
 */
function NoLocalChanges({
    model,
    place,
    projectId,
    git,
    draft,
    remote,
    running: runningAction,
}: CommitBoxProps & { draft: CommitDraft; remote: RemoteActions; running: RemoteActionId | undefined }) {
    const apps = useOpenApps();
    const { facts } = model;
    const { state, link } = createPullRequestOf(facts, git);
    const step: NextStep | undefined = nextStep(facts.status.value, state);
    const target: OpenTarget = {
        projectId,
        folder: place.folder,
        path: placePath(place),
        relative: '',
        kind: 'directory',
        ...(place.workspace && { workspace: place.workspace }),
    };
    const quiet = openActions({ target, programs: chosenPrograms(apps), git, effects: openEffects }).filter(action =>
        QUIET_ACTIONS.includes(action.id)
    );
    // What is running is read by the box and given here, so the step follows it where the parts of the sidebar are not observers of their own.
    const running = step !== undefined && step.kind !== 'pullRequest' && runningAction === step.kind;
    const { failure, committed } = draft;

    return (
        <section className={styles.root} aria-label="Commit">
            <Text variant="sm" weight="medium">
                No local changes
            </Text>
            {failure ? (
                <FailureLines failure={failure} draft={draft} remote={remote} />
            ) : (
                committed && (
                    <Text variant="xs" color="secondary" role="status">
                        {committedWords(draft)}
                    </Text>
                )
            )}
            {step && (
                <div className={styles.step}>
                    <Button
                        color="primary"
                        size="sm"
                        className={styles.stepButton}
                        contentClassName={styles.stepText}
                        isDisabled={runningAction !== undefined && !running}
                        isPending={running}
                        spinnerPlacement="start"
                        onPress={() =>
                            step.kind === 'pullRequest' ? link && openEffects.openUrl(link) : void remote.run(step.kind)
                        }
                    >
                        {step.title}
                    </Button>
                    <Text variant="xs" color="secondary">
                        {step.description}
                    </Text>
                </div>
            )}
            {quiet.length > 0 && (
                <div className={styles.quiet}>
                    {quiet.map(action => (
                        <Button
                            key={action.id}
                            variant="filling"
                            color="secondary"
                            size="xs"
                            className={styles.quietButton}
                            contentClassName={styles.quietContent}
                            isDisabled={action.isDisabled}
                            onPress={action.run}
                        >
                            {actionIcon(action)}
                            <Text variant="xs" weight="medium" truncate>
                                {quietLabel(action)}
                            </Text>
                        </Button>
                    ))}
                </div>
            )}
        </section>
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
 * knows; the daemon decides again when it is asked), and writes only into an empty box or over what it wrote itself. Commit is the one filled primary action of the place and names what it
 * does as GitHub Desktop's does (`Commit 3 files to main`), with the tooltips `A commit summary is required to commit` and `Select one or more files to commit` while it is off, and a line under
 * the box (`Committing to main, the base branch`) when the branch is the one the work is compared with; Cmd or Ctrl and Enter in the box does the same. What git or the agent said is shown as it
 * said it, and the box is as it was. Beside Commit is a menu with **Commit & Push**: it commits as Commit does, then sends the branch (a push, or its publishing when it is not on origin); the
 * commit stands whatever the push comes to, the box is clear, and a push that failed is said with it (`Committed 1a2b3c4, push failed: <git's line>`, with a Fetch origin button when origin has
 * newer commits), the sidebar's sync button then saying what to do. The entry is off, with the reason under it, where the push after the commit would not be taken (no origin, a detached HEAD,
 * a branch that is behind or has diverged). With nothing to commit the box is `NoLocalChanges`.
 */
export function CommitBox({ model, place, projectId, git }: CommitBoxProps) {
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

    // Nothing is uncommitted: the commit that was made, or why the push after it failed, and the next step of the branch.
    if (files.length === 0)
        return (
            <NoLocalChanges
                model={model}
                place={place}
                projectId={projectId}
                git={git}
                draft={draft}
                remote={remote}
                running={remote.running}
            />
        );

    const target = commitTarget(model.facts.status.value);
    const reason = draft.commitReason;

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
                    <Unavailable label={commitLabel(ticked, target?.name)} hint={reason} className={styles.commitHost}>
                        <Button
                            color="primary"
                            size="sm"
                            className={styles.commit}
                            contentClassName={styles.commitContent}
                            isDisabled={!draft.canCommit}
                            isPending={draft.writing}
                            tooltip={reason === undefined && target ? `Commit to ${target.name}` : undefined}
                            tooltipPlacement="top"
                            onPress={() => void draft.commit()}
                        >
                            <span className={styles.commitText}>{breakable(commitLabel(ticked, target?.name))}</span>
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
            {failure && <FailureLines failure={failure} draft={draft} remote={remote} />}
            {!failure && !busy && committed && (
                <Text variant="xs" color="secondary" role="status">
                    {committedWords(draft)}
                </Text>
            )}
        </section>
    );
}
