import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { Panel, PanelEmptyRow, PanelHeader } from '@clowdy/components/Panel';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { ArrowLeft, Version } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';
import { commitScope } from '@clowdy/protocol';

import { formatFullTime, formatMessageTime } from '../../shared/time';
import { openEffects, useFolderGit } from '../openWith';
import { githubLink } from '../openWith/openTarget';
import { isCommitScope } from './changeScopes';
import styles from './ChangesSidebar.module.css';
import { accessHint, accessHintTitle, aheadBehindCounts, CHANGE_KIND_VIEW, splitPath } from './gitSummary';
import { PullRequestChip } from './PullRequestChip';

import type { GitChangedFile, GitCommit, GitStatus } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { Place } from '../sidePanel/currentPlace';
import type { PlaceChanges } from './PlaceChanges';

/** How the checked-out head is named: the branch, or the commit a detached head is at. Nothing until the status has been read, and for a folder that is no repository. */
export function headName(status: GitStatus | undefined): string | undefined {
    if (status?.isRepository !== true) return undefined;

    const { head } = status;

    return head.kind === 'detached' ? `Detached at ${ head.commit.slice(0, 7) }` : head.name;
}

/** The title of a section of the sidebar, and how many it lists. */
function SectionHeader({ title, count }: { title: string; count?: number }) {
    return (
        <div className={ styles.sectionHeader }>
            <Text variant="xs" weight="medium" color="secondary">{ title }</Text>
            { count !== undefined && <Text variant="xs" color="secondary">{ count }</Text> }
        </div>
    );
}

/** One changed file of the scope: what happened to it, its name with its folder dimmed after it, and its lines. A press brings its card to the top and opens it. */
function FileRow({ file, onOpen }: { file: GitChangedFile; onOpen: (path: string) => void }) {
    const kind = CHANGE_KIND_VIEW[file.kind];
    const { folder, name } = splitPath(file.path);

    return (
        <Button variant="filling" color="secondary" size="xs" className={ styles.row } contentClassName={ styles.rowContent } tooltip={ file.path } tooltipPlacement="left" onPress={ () => onOpen(file.path) }>
            <Text variant="xs" weight="medium" color={ kind.color } className={ styles.glyph } title={ kind.label } aria-label={ kind.label }>{ kind.glyph }</Text>
            <span className={ styles.fileName }>
                <Text variant="xs" weight="medium" truncate className={ styles.name }>{ name }</Text>
                { folder && <Text variant="xs" color="secondary" truncate className={ styles.folderHint }>{ folder.slice(0, -1) }</Text> }
            </span>
            { file.additions !== undefined && file.deletions !== undefined && (
                <span className={ styles.counts }>
                    <Text variant="xs" color="success">{ `+${ file.additions }` }</Text>
                    <Text variant="xs" color="danger">{ `−${ file.deletions }` }</Text>
                </span>
            ) }
        </Button>
    );
}

/** One commit of the branch: its message, and under it its short hash and when it was made. A press shows that commit alone; the one that is shown is marked. */
function CommitRow({ commit, current, onPick }: { commit: GitCommit; current: boolean; onPick: () => void }) {
    return (
        <Button
            variant="filling"
            color="secondary"
            size="xs"
            className={ styles.commit }
            contentClassName={ styles.commitContent }
            isPressed={ current }
            tooltip={ `${ commit.shortSha } by ${ commit.author }` }
            tooltipPlacement="left"
            onPress={ onPick }
        >
            <Text variant="xs" weight="medium" truncate className={ styles.subject }>{ commit.subject }</Text>
            <span className={ styles.commitMeta }>
                <Text variant="xs" color="secondary" className={ styles.sha }>{ commit.shortSha }</Text>
                <time dateTime={ new Date(commit.committedAt).toISOString() } title={ formatFullTime(commit.committedAt) }>
                    <Text variant="xs" color="secondary">{ formatMessageTime(commit.committedAt) }</Text>
                </time>
            </span>
        </Button>
    );
}

/**
 * The sidebar of the tab, at the right of the diffs: the branch the place is on with its base and how far it is from it, the pull request, the files of the scope (a press brings
 * their card up, and the filter above the cards narrows this list too) and the commits of the branch (a press shows one commit alone, and a row above them goes back to all
 * changes). The room above the lists is the sidebar's own, for what the person acts with (commit, sync). `toggle` is the button that hides the sidebar, at the end of its header.
 */
export function ChangesSidebar({ model, place, projectId, onOpenFile, toggle }: { model: PlaceChanges; place: Place; projectId: string; onOpenFile: (path: string) => void; toggle: ReactNode }) {
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
    const commits = base?.commits ?? [];
    const onCommit = isCommitScope(model.effectiveScope);

    return (
        <Panel side="right" className={ styles.sidebar } aria-label="Changes sidebar">
            <PanelHeader>
                <span className={ styles.branch }>
                    <Version aria-hidden="true" className={ styles.branchIcon } />
                    <Text weight="medium" truncate title={ branch }>{ branch ?? 'Changes' }</Text>
                </span>
                <PanelHeader.Actions>
                    { repositoryLink && (
                        <PanelHeader.Button aria-label="Open the repository on GitHub" tooltip="Open on GitHub" tooltipPlacement="bottom" onPress={ () => openEffects.openUrl(repositoryLink) }>
                            <Github size={ 14 } />
                        </PanelHeader.Button>
                    ) }
                    { toggle }
                </PanelHeader.Actions>
            </PanelHeader>

            <div className={ styles.body }>
                { (base || pr || hint) && (
                    <div className={ styles.facts }>
                        { base && (
                            <Text variant="xs" color="secondary" truncate title={ `${ base.name }, ${ counts }` }>
                                { `→ ${ base.name }` }
                                { counts && ` · ${ counts }` }
                            </Text>
                        ) }
                        { pr && <PullRequestChip pr={ pr } stale={ facts.pullRequest.stale } /> }
                        { hint && <Text variant="xs" color="secondary" truncate title={ accessHintTitle(facts.access, facts.repo) }>{ hint }</Text> }
                    </div>
                ) }

                <section className={ styles.files } aria-label="Changed files">
                    <SectionHeader title="Changed files" count={ model.changes ? files.length : undefined } />
                    { files.length > 0
                        ? (
                            <Scrollable className={ styles.list } contentClass={ styles.rows }>
                                <For each={ [...files] }>
                                    { file => <FileRow key={ file.path } file={ file } onOpen={ onOpenFile } /> }
                                </For>
                            </Scrollable>
                        )
                        : <PanelEmptyRow>{ model.changes && model.filter.trim() !== '' && model.changes.files.length > 0 ? 'No files match the filter' : 'No changed files' }</PanelEmptyRow> }
                </section>

                { base && (
                    <section className={ styles.commits } aria-label="Committed on branch">
                        <SectionHeader title="Committed on branch" count={ base.ahead } />
                        { onCommit && (
                            <Button variant="filling" color="secondary" size="xs" className={ styles.back } onPress={ () => model.setScope('all') }>
                                <ArrowLeft aria-hidden="true" />
                                Back to all changes
                            </Button>
                        ) }
                        { commits.length > 0
                            ? (
                                <Scrollable className={ styles.list } contentClass={ styles.rows }>
                                    <For each={ commits }>
                                        { commit => <CommitRow key={ commit.sha } commit={ commit } current={ model.effectiveScope === commitScope(commit.sha) } onPick={ () => model.pickCommit(commit.sha) } /> }
                                    </For>
                                    { base.ahead > commits.length && <Text variant="xs" color="secondary" className={ styles.more }>{ `Showing the newest ${ commits.length }` }</Text> }
                                </Scrollable>
                            )
                            : <PanelEmptyRow>No commits on the branch yet</PanelEmptyRow> }
                    </section>
                ) }
            </div>
        </Panel>
    );
}
