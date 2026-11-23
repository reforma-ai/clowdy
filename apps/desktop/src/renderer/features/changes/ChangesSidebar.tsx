import { For } from '@clowdy/components/For';
import { GridList, GridListItem, listBoxItemDataShow } from '@clowdy/components/List';
import { Panel, PanelEmptyRow, PanelHeader } from '@clowdy/components/Panel';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { Check, Version } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';

import { openEffects, useFolderGit } from '../openWith';
import { githubLink } from '../openWith/openTarget';
import { BranchCommits } from './BranchCommits';
import { BranchPicker } from './BranchPicker';
import styles from './ChangesSidebar.module.css';
import { CommitBox } from './CommitBox';
import { CreatePullRequest } from './CreatePullRequest';
import { DiscardButton } from './DiscardButton';
import { accessHint, accessHintTitle, aheadBehindCounts, CHANGE_KIND_VIEW, splitPath } from './gitSummary';
import { CHANGES_FILES_MIN_HEIGHT } from './layout';
import { LIST_TEXT } from './listState';
import { PullRequestChip } from './PullRequestChip';
import { RemoteMenu } from './RemoteMenu';
import { useBoxHeight } from './useBoxWidth';

import type { GitChangedFile, GitStatus } from '@clowdy/protocol';
import type { ReactNode, SyntheticEvent } from 'react';
import type { Place } from '../sidePanel/currentPlace';
import type { PlaceChanges } from './PlaceChanges';

/** How the checked-out head is named: the branch, or the commit a detached head is at. Nothing until the status has been read, and for a folder that is no repository. */
export function headName(status: GitStatus | undefined): string | undefined {
    if (status?.isRepository !== true) return undefined;

    const { head } = status;

    return head.kind === 'detached' ? `Detached at ${head.commit.slice(0, 7)}` : head.name;
}

/** What the files section says when it lists none: that the filter lets nothing through, that every file it lets through is viewed and hidden, or that nothing changed. */
function emptyFilesWords(model: PlaceChanges): string {
    if (model.hideViewed && model.matchingFiles.length > 0) return LIST_TEXT.allViewed;

    return model.changes && model.filter.trim() !== '' && model.changes.files.length > 0
        ? 'No files match the filter'
        : 'No changed files';
}

/** The title of a section of the sidebar, and how many it lists. */
function SectionHeader({ title, count }: { title: string; count?: number }) {
    return (
        <div className={styles.sectionHeader}>
            <Text variant="xs" weight="medium" color="secondary" truncate>
                {title}
            </Text>
            {count !== undefined && (
                <Text variant="xs" color="secondary">
                    {count}
                </Text>
            )}
        </div>
    );
}

/** What the row's own controls keep to themselves: a press or a key on them is theirs, and not the row's action too. */
const ownEvents = {
    onClick: (event: SyntheticEvent) => event.stopPropagation(),
    onPointerDown: (event: SyntheticEvent) => event.stopPropagation(),
    onKeyDown: (event: SyntheticEvent) => event.stopPropagation(),
};

/**
 * One changed file of the scope, a row of the design system's list: what happened to it, its name with its folder dimmed after it (the whole path on hover), its lines, and a tick when it is
 * viewed. Its action (a press, or Enter on the row the arrows reached) brings its card to the top and opens it. A file whose changes can be discarded (`discard`, its uncommitted entry) has
 * `Discard changes…` at the end of its row, in the place of the tick, while the pointer is over the row or the focus is in it: the row action of the design system's list, as a chat's
 * row has its own (`listBoxItemDataShow`), reached from the row with the right arrow.
 */
function FileRow({
    file,
    viewed,
    model,
    discard,
}: {
    file: GitChangedFile;
    viewed: boolean;
    model: PlaceChanges;
    discard: GitChangedFile | undefined;
}) {
    const kind = CHANGE_KIND_VIEW[file.kind];
    const { folder, name } = splitPath(file.path);

    return (
        <GridListItem
            id={file.path}
            textValue={file.path}
            data-path={file.path}
            icon={
                <Text
                    variant="sm"
                    weight="medium"
                    color={kind.color}
                    className={styles.glyph}
                    title={kind.label}
                    aria-label={kind.label}
                >
                    {kind.glyph}
                </Text>
            }
            endAffix={
                <span className={styles.rowEnd}>
                    {file.additions !== undefined && file.deletions !== undefined && (
                        <span className={styles.counts}>
                            <Text variant="sm" color="success">{`+${file.additions}`}</Text>
                            <Text variant="sm" color="danger">{`−${file.deletions}`}</Text>
                        </span>
                    )}
                    {/* The tick and the button share one place: the tick at rest, the button while the row is aimed at. */}
                    <span className={styles.mark}>
                        <span className={styles.tick} data-show={discard ? listBoxItemDataShow.itemRest : undefined}>
                            {viewed && <Check role="img" title="Viewed" aria-label="Viewed" />}
                        </span>
                        {discard && (
                            // The button is a React child of the row, so its presses and keys would reach the row through the tree too.
                            <span className={styles.discard} data-show={listBoxItemDataShow.itemBoth} {...ownEvents}>
                                <DiscardButton model={model} file={discard} />
                            </span>
                        )}
                    </span>
                </span>
            }
        >
            <Text slot="label" className={styles.fileName} title={file.path}>
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
 * The sidebar of the tab, at the right of the diffs: the branch the place is on with its base and how far it is from it, the pull request, the files of the scope (a press brings
 * their card up, and the filter above the cards narrows this list too), the commit box, and at its foot the commits of the branch, a spoiler that is shut by default
 * (`BranchCommits`: a press on one shows that commit alone, and a row above them goes back to all changes). The facts at the top are where the person acts on the branch: the base and how far the branch is from it, the row that says how it stands against its upstream and opens the menu
 * of Fetch, Pull and Push or Publish (`RemoteMenu`), and the pull request as the shared chip, or, while there is none, Create PR (`CreatePullRequest`), which opens GitHub's compare page
 * once the branch is on origin. `toggle` is the button that hides the sidebar, at the end of its header.
 */
export function ChangesSidebar({
    model,
    place,
    projectId,
    onOpenFile,
    toggle,
}: {
    model: PlaceChanges;
    place: Place;
    projectId: string;
    onOpenFile: (path: string) => void;
    toggle: ReactNode;
}) {
    const { facts } = model;
    const git = useFolderGit(projectId, place.folder.id, place.workspace);
    const status = facts.status.value;
    const branch = headName(status);
    const base = facts.base?.state === 'ready' ? facts.base : undefined;
    const counts = aheadBehindCounts(base);
    const { pr } = facts;
    const hint = pr ? undefined : accessHint(facts.access, facts.repo);
    const repositoryLink = githubLink(git, { relative: '', kind: 'directory' });
    const files = model.files;
    // Read here, with the list: the rows are drawn by a callback of `For`, which does not follow the model, so a tick that changes reaches them through this component.
    const viewed = model.viewedPaths;
    // Read here for the same reason: the rows are drawn by a callback, and the files that can be discarded change with the scope and with the uncommitted list.
    const discardable = model.discardable;
    const [commitBoxRef, commitBoxHeight] = useBoxHeight();

    return (
        <Panel side="right" className={styles.sidebar} aria-label="Changes sidebar">
            <PanelHeader>
                {branch !== undefined && status?.isRepository === true && status.head.kind !== 'unborn' ? (
                    <BranchPicker facts={facts} place={place} label={branch} />
                ) : (
                    <span className={styles.branch}>
                        <Version aria-hidden="true" className={styles.branchIcon} />
                        <Text weight="medium" truncate title={branch}>
                            {branch ?? 'Changes'}
                        </Text>
                    </span>
                )}
                <PanelHeader.Actions>
                    {repositoryLink && (
                        <PanelHeader.Button
                            aria-label="Open the repository on GitHub"
                            tooltip="Open on GitHub"
                            tooltipPlacement="bottom"
                            onPress={() => openEffects.openUrl(repositoryLink)}
                        >
                            <Github size={14} />
                        </PanelHeader.Button>
                    )}
                    {toggle}
                </PanelHeader.Actions>
            </PanelHeader>

            <div className={styles.body}>
                {(base || pr || hint || status?.isRepository === true) && (
                    <div className={styles.facts}>
                        {base && (
                            <Text variant="xs" color="secondary" truncate title={`${base.name}, ${counts}`}>
                                {`→ ${base.name}`}
                                {counts && ` · ${counts}`}
                            </Text>
                        )}
                        <RemoteMenu facts={facts} />
                        {pr ? (
                            <PullRequestChip pr={pr} stale={facts.pullRequest.stale} />
                        ) : (
                            <CreatePullRequest facts={facts} git={git} />
                        )}
                        {hint && (
                            <Text
                                variant="xs"
                                color="secondary"
                                truncate
                                title={accessHintTitle(facts.access, facts.repo)}
                            >
                                {hint}
                            </Text>
                        )}
                    </div>
                )}

                <BranchCommits model={model} base={base} reserved={commitBoxHeight + CHANGES_FILES_MIN_HEIGHT}>
                    {/* Focusable from code alone: it takes the focus when a discard took the list's last row (`keepFocusWhenGone`). */}
                    <section className={styles.files} aria-label="Changed files" tabIndex={-1}>
                        <SectionHeader title="Changed files" count={model.changes ? files.length : undefined} />
                        {files.length > 0 ? (
                            <Scrollable className={styles.list} contentClass={styles.rows}>
                                <GridList
                                    aria-label="Changed files"
                                    size="sm"
                                    onAction={key => onOpenFile(String(key))}
                                >
                                    <For each={[...files]}>
                                        {file => (
                                            <FileRow
                                                key={file.path}
                                                file={file}
                                                viewed={viewed.has(file.path)}
                                                model={model}
                                                discard={discardable.get(file.path)}
                                            />
                                        )}
                                    </For>
                                </GridList>
                            </Scrollable>
                        ) : (
                            <PanelEmptyRow>{emptyFilesWords(model)}</PanelEmptyRow>
                        )}
                    </section>

                    {/* Measured: the commits' box can be dragged up to it and no further. */}
                    <div ref={commitBoxRef} className={styles.commitBox}>
                        <CommitBox model={model} place={place} projectId={projectId} git={git} />
                    </div>
                </BranchCommits>
            </div>
        </Panel>
    );
}
