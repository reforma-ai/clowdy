import { Button } from '@clowdy/components/Button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, useCollapsible } from '@clowdy/components/Collapsible';
import { For } from '@clowdy/components/For';
import { ListBox, ListBoxItem } from '@clowdy/components/List';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from '@clowdy/components/Resizable';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { ChevronUp } from '@clowdy/icons/8';
import { ArrowLeft } from '@clowdy/icons/14';
import { commitScope } from '@clowdy/protocol';
import { type ReactNode, useId, useState } from 'react';

import { formatFullTime, formatMessageTime } from '../../shared/time';
import styles from './BranchCommits.module.css';
import { isCommitScope } from './changeScopes';
import { CHANGES_COMMITS_MIN_HEIGHT } from './layout';
import { changesSidebarLayout, defaultCommitsHeight, fitCommitsHeight } from './sidebarLayout';
import { useBoxHeight } from './useBoxWidth';

import type { GitBase, GitCommit } from '@clowdy/protocol';
import type { PlaceChanges } from './PlaceChanges';

/** A base the branch can be compared with: the one that has the branch's commits. */
type ReadyBase = Extract<GitBase, { state: 'ready' }>;

/** The key of the row above the commits that goes back to all changes: no commit's hash. */
const ALL_CHANGES_ROW = 'all-changes';

/**
 * One commit of the branch, an option of the design system's list: its message, and under it its short hash and when it was made (the author on hover). Choosing it shows that
 * commit alone; the one that is shown is the selected option, and choosing it again goes back to all changes.
 */
function CommitRow({ commit }: { commit: GitCommit }) {
    return (
        <ListBoxItem
            id={commit.sha}
            textValue={commit.subject}
            stacked
            description={
                <span className={styles.meta}>
                    <span className={styles.sha}>{commit.shortSha}</span>
                    <time
                        dateTime={new Date(commit.committedAt).toISOString()}
                        title={formatFullTime(commit.committedAt)}
                    >
                        {formatMessageTime(commit.committedAt)}
                    </time>
                </span>
            }
        >
            <Text slot="label" weight="medium" title={`${commit.shortSha} by ${commit.author}`}>
                {commit.subject}
            </Text>
        </ListBoxItem>
    );
}

/** The commits as a list (newest first, at most what the daemon sends), with the row that goes back to all changes while one commit is shown, and a note when the list was cut. */
function CommitList({ model, base }: { model: PlaceChanges; base: ReadyBase }) {
    const { commits } = base;
    // The commit that is shown, as the list's selection.
    const shown = commits.find(commit => model.effectiveScope === commitScope(commit.sha))?.sha;

    return (
        <Scrollable className={styles.scroller} contentClass={styles.rows}>
            <ListBox
                aria-label="Commits on branch"
                size="sm"
                selectionMode="single"
                selectedKeys={shown}
                onSelectionChange={keys => {
                    const [key] = keys === 'all' ? [] : [...keys];

                    // Choosing the commit that is shown again, or the row above the commits, goes back to all changes.
                    if (key === undefined || key === ALL_CHANGES_ROW) model.setScope('all');
                    else model.pickCommit(String(key));
                }}
            >
                {isCommitScope(model.effectiveScope) && (
                    <ListBoxItem
                        id={ALL_CHANGES_ROW}
                        text="Back to all changes"
                        icon={<ArrowLeft aria-hidden="true" />}
                    />
                )}
                <For each={commits}>{commit => <CommitRow key={commit.sha} commit={commit} />}</For>
            </ListBox>
            {base.ahead > commits.length && (
                <Text
                    variant="sm"
                    color="secondary"
                    className={styles.more}
                >{`Showing the newest ${commits.length}`}</Text>
            )}
        </Scrollable>
    );
}

/**
 * The bar at the foot of the sidebar that opens and shuts the commits, one row tall and a button over its whole width: `Commits on branch · 3` and a chevron that points the way the
 * list goes. A branch with no commit ahead of its base has the bar, off, with `No commits on the branch yet`.
 */
function CommitsBar({ count }: { count: number }) {
    const { state, isDisabled } = useCollapsible();

    return (
        <div className={styles.bar} data-commits-bar="">
            <CollapsibleTrigger asChild>
                <Button
                    variant="filling"
                    color="secondary"
                    size="sm"
                    className={styles.barButton}
                    contentClassName={styles.barContent}
                    isDisabled={isDisabled}
                >
                    <Text variant="xs" weight="medium" color="secondary" truncate>
                        {isDisabled ? 'No commits on the branch yet' : `Commits on branch · ${count}`}
                    </Text>
                    <ChevronUp aria-hidden="true" aria-expanded={state.isExpanded} className="chevron" />
                </Button>
            </CollapsibleTrigger>
        </div>
    );
}

/**
 * The commits' box above the bar and the edge that drags it, built each time the commits open: its height is read then (`initial`), and a double press on the edge puts it back to
 * the height it opens at by default (`onReset`), which the panel library's own double press would not do once the person had dragged it.
 */
function CommitsPanel({
    panelRef,
    initial,
    onReset,
    children,
}: {
    panelRef: ReturnType<typeof usePanelRef>;
    initial: number;
    onReset: () => void;
    children: ReactNode;
}) {
    const [opened] = useState(initial);
    const id = useId();

    return (
        <>
            <ResizableHandle aria-label="Resize the commits" disableDoubleClick onDoubleClick={onReset} />
            <ResizablePanel
                id={id}
                panelRef={panelRef}
                className={styles.panel}
                defaultSize={opened}
                minSize={CHANGES_COMMITS_MIN_HEIGHT}
                groupResizeBehavior="preserve-pixel-size"
            >
                <CollapsibleContent className={styles.content}>{children}</CollapsibleContent>
            </ResizablePanel>
        </>
    );
}

/**
 * The lists of the sidebar under its facts: what `children` holds (the changed files and the commit box) and, docked at the foot, the commits of the branch as a spoiler. It is
 * shut by default, a bar (`Commits on branch · 3`); open, the list stands above the bar, as tall as the person drags its top edge (`Resizable`: five rows to start, fewer for a
 * branch with fewer commits, never more than 40% of the column, two rows at the least, and never over the files and the commit box, which keep `reserved`), and the files take
 * what is left and scroll on their own. Whether it is open and its height are the window's (`changesSidebarLayout`). No bar while the branch has no base to be ahead of.
 */
export function BranchCommits({
    model,
    base,
    reserved,
    children,
}: {
    model: PlaceChanges;
    base: ReadyBase | undefined;
    /** What the files and the commit box need above the commits, in pixels. */
    reserved: number;
    children: ReactNode;
}) {
    const layout = changesSidebarLayout;
    const commits = base?.commits ?? [];
    const [columnRef, available] = useBoxHeight();
    const panel = usePanelRef();
    const id = useId();
    const open = layout.commitsOpen && commits.length > 0;
    const fallback = defaultCommitsHeight(commits.length, available);

    return (
        <Collapsible
            as="Fragment"
            open={open}
            isDisabled={commits.length === 0}
            onOpenChange={() => layout.toggleCommits()}
        >
            <div ref={columnRef} className={styles.column}>
                <ResizablePanelGroup
                    orientation="vertical"
                    // Only the person's own drag is kept: the column that is resized changes the layout too.
                    onLayoutChanged={(_layout, meta) => {
                        if (!meta.isUserInteraction) return;

                        // After the layout has landed: a key press announces its change a step before the panel's size shows it.
                        requestAnimationFrame(() => {
                            if (panel.current) layout.setCommitsHeight(panel.current.getSize().inPixels);
                        });
                    }}
                >
                    <ResizablePanel id={`${id}-files`} className={styles.panel} minSize={reserved}>
                        {children}
                    </ResizablePanel>

                    {/* Built once the column has a height, so the box opens at a height that fits it. */}
                    <Show when={open && base !== undefined && available > 0}>
                        <CommitsPanel
                            panelRef={panel}
                            initial={fitCommitsHeight(layout.commitsHeight ?? fallback, available, reserved)}
                            onReset={() => {
                                layout.resetCommitsHeight();
                                panel.current?.resize(fitCommitsHeight(fallback, available, reserved));
                            }}
                        >
                            {base && <CommitList model={model} base={base} />}
                        </CommitsPanel>
                    </Show>
                </ResizablePanelGroup>
            </div>
            {base && <CommitsBar count={base.ahead} />}
        </Collapsible>
    );
}
