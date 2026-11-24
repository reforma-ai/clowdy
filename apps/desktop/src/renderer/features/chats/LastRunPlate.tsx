import { Collapsible, CollapsibleTrigger } from '@clowdy/components/Collapsible';
import { GridListItem } from '@clowdy/components/List';
import { Text } from '@clowdy/components/Text';

import { useProjectState, useRootStore } from '../../stores';
import { chatFolder } from '../agents/agentTree';
import { CHANGE_KIND_VIEW, filesWords, splitPath } from '../changes/gitSummary';
import { openRunInChanges } from '../changes/openRunInChanges';
import { chatPlace, isPlaceReady } from '../sidePanel/currentPlace';
import { ComposerBanner, ComposerBannerHeader, ComposerBannerList } from './ComposerBanner';
import styles from './LastRunPlate.module.css';
import { isLastRunCurrent, lastRunScope, plateFilesOf, plateTotals, rowCounts, rowLabel } from './lastRunRows';
import { useLastRunChanges } from './useLastRunChanges';

import type { Chat, GitChangedFile, GitScope, Run, StreamItem } from '@clowdy/protocol';
import type { RepositoryChanges } from '../changes/PlaceChanges';

/** The path of a file as the Changes tab's cards write it, as the row's label: the folder dimmed and the name after it. A path too long for its room is cut at its start, so the name stays. */
function PathLabel({ path }: { path: string }) {
    const { folder, name } = splitPath(path);

    return (
        <Text slot="label" className={styles.path} dir="rtl" title={path}>
            <bdi dir="ltr">
                {folder && (
                    <Text variant="xs" color="secondary">
                        {folder}
                    </Text>
                )}
                <Text variant="xs">{name}</Text>
            </bdi>
        </Text>
    );
}

/**
 * One changed file of the run, a row of the design system's list: the letter of what happened to it, its path, and its lines at the end. A screen reader hears the row as what
 * happened, the path and the lines (`rowLabel`), so the letter and the lines are hidden from it. Its action opens the Changes tab on the run with the file's card up.
 */
function Row({ file }: { file: GitChangedFile }) {
    const kind = CHANGE_KIND_VIEW[file.kind];
    const counts = rowCounts(file);

    return (
        <GridListItem
            id={file.path}
            textValue={rowLabel(file)}
            icon={
                <Text variant="xs" weight="medium" color={kind.color} className={styles.glyph} aria-hidden>
                    {kind.glyph}
                </Text>
            }
            endAffix={
                counts ? (
                    <span className={styles.counts} aria-hidden>
                        <Text variant="xs" color="success">
                            {counts.additions}
                        </Text>
                        <Text variant="xs" color="danger">
                            {counts.deletions}
                        </Text>
                    </span>
                ) : undefined
            }
        >
            <PathLabel path={file.path} />
        </GridListItem>
    );
}

/** A one-line summary of the run that opens to show all its changed files in a scrollable list. */
function RunPlate({ changes, onOpen }: { changes: RepositoryChanges; onOpen: (path: string) => void }) {
    const totals = plateTotals(changes);

    return (
        <ComposerBanner role="group" aria-label="Changes from the last run">
            <Collapsible as="Fragment" defaultOpen={false}>
                {({ state }) => (
                    <>
                        <CollapsibleTrigger asChild>
                            <ComposerBannerHeader
                                expanded={state.isExpanded}
                                summary={
                                    <>
                                        <Text variant="xs" color="secondary">
                                            {filesWords(changes.fileCount)}
                                        </Text>
                                        <span className={styles.counts}>
                                            <Text variant="xs" color="success">
                                                {totals.additions}
                                            </Text>
                                            <Text variant="xs" color="danger">
                                                {totals.deletions}
                                            </Text>
                                        </span>
                                    </>
                                }
                            >
                                Last run changes
                            </ComposerBannerHeader>
                        </CollapsibleTrigger>
                        {state.isExpanded && (
                            <ComposerBannerList label="Files the run changed" onAction={onOpen}>
                                {changes.files.map(file => (
                                    <Row key={file.path} file={file} />
                                ))}
                            </ComposerBannerList>
                        )}
                    </>
                )}
            </Collapsible>
        </ComposerBanner>
    );
}

/**
 * The Changes summary over the message box after a run that changed files. The daemon took two trees of the chat's place around the run's turn
 * (`Chat.lastRun`), and the list is their difference, so it is what the run did whatever happens to the files afterwards. It is drawn while the chat is at rest after such a run and
 * the person has not written since: not while a run works, not with a message waiting in the queue or sent after the run, not for a run that changed nothing, and not when the
 * list of the run cannot be read (git has pruned the trees). It is drawn for a chat that cannot be written to as well. A press on a file opens the Changes tab on the run's scope with that file's
 * card up (`openRunInChanges`).
 */
export function LastRunPlate({
    chat,
    run,
    items,
}: {
    chat: Chat;
    run: Run | undefined;
    items: readonly StreamItem[] | undefined;
}) {
    const root = useRootStore();
    const project = useProjectState();
    const { folders } = project.project;
    const place = chatPlace(folders, chat, chatFolder(project.chats, folders, chat.id)?.folder);
    const scope: GitScope | undefined = lastRunScope(chat);
    const current = scope !== undefined && isPlaceReady(place) && isLastRunCurrent({ chat, run, items });
    // Read only while the plate could be drawn: a run that works or a message the person has written means no plate, and the answer of a scope never changes, so there is nothing to refresh.
    const changes = plateFilesOf(useLastRunChanges(project.id, place, current ? scope : undefined));

    if (!current || !changes) return null;

    return (
        <RunPlate
            key={scope}
            changes={changes}
            onOpen={path => openRunInChanges(root, project.id, place, chat.id, scope, path)}
        />
    );
}
