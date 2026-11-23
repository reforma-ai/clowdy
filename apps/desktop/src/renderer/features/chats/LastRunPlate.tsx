import { Text } from '@clowdy/components/Text';
import { ChatChanged, ChevronDown, ChevronUp } from '@clowdy/icons/14';
import { useId, useState } from 'react';

import { useProjectState, useRootStore } from '../../stores';
import { chatFolder } from '../agents/agentTree';
import { CHANGE_KIND_VIEW, splitPath } from '../changes/gitSummary';
import { openRunInChanges } from '../changes/openRunInChanges';
import { chatPlace, isPlaceReady } from '../sidePanel/currentPlace';
import { ComposerBanner } from './ComposerBanner';
import styles from './LastRunPlate.module.css';
import {
    chevronWords,
    hiddenRows,
    isLastRunCurrent,
    lastRunScope,
    plateFilesOf,
    plateTitle,
    plateTotals,
    rowCounts,
    rowLabel,
    visibleRows,
} from './lastRunRows';
import { useLastRunChanges } from './useLastRunChanges';

import type { Chat, GitChangedFile, GitScope, Run, StreamItem } from '@clowdy/protocol';
import type { RepositoryChanges } from '../changes/PlaceChanges';

/** The path of a file as the Changes tab's cards write it: the folder dimmed and the name after it. A path too long for its room is cut at its start, so the name stays. */
function PathLabel({ path }: { path: string }) {
    const { folder, name } = splitPath(path);

    return (
        <span className={styles.path} dir="rtl" title={path}>
            <bdi dir="ltr">
                {folder && (
                    <Text variant="xs" color="secondary">
                        {folder}
                    </Text>
                )}
                <Text variant="xs">{name}</Text>
            </bdi>
        </span>
    );
}

/** One changed file of the run: the letter of what happened to it, its path, and its lines at the end. A press opens the Changes tab on the run with the file's card up. */
function Row({ file, onOpen }: { file: GitChangedFile; onOpen: (path: string) => void }) {
    const kind = CHANGE_KIND_VIEW[file.kind];
    const counts = rowCounts(file);

    return (
        <button type="button" className={styles.row} aria-label={rowLabel(file)} onClick={() => onOpen(file.path)}>
            <Text variant="xs" weight="medium" color={kind.color} className={styles.glyph} aria-hidden>
                {kind.glyph}
            </Text>
            <PathLabel path={file.path} />
            {counts && (
                <span className={styles.counts} aria-hidden>
                    <Text variant="xs" color="success">
                        {counts.additions}
                    </Text>
                    <Text variant="xs" color="danger">
                        {counts.deletions}
                    </Text>
                </span>
            )}
        </button>
    );
}

/** The plate for one run: the header with the totals, the first files, and the chevron that unfolds the rest (folded again for the next run, which is a new plate). */
function RunPlate({ changes, onOpen }: { changes: RepositoryChanges; onOpen: (path: string) => void }) {
    const [unfolded, setUnfolded] = useState(false);
    const rows = useId();
    const totals = plateTotals(changes);
    const hidden = hiddenRows(changes.files);

    return (
        <ComposerBanner role="group" aria-label="Last run">
            <div className={styles.header}>
                <span className={styles.icon} aria-hidden>
                    <ChatChanged />
                </span>
                <Text variant="xs" color="secondary" className={styles.title}>
                    {plateTitle(changes)}
                </Text>
                <span className={styles.counts}>
                    <Text variant="xs" color="success">
                        {totals.additions}
                    </Text>
                    <Text variant="xs" color="danger">
                        {totals.deletions}
                    </Text>
                </span>
            </div>
            <div id={rows} className={unfolded ? styles.unfolded : styles.rows}>
                {visibleRows(changes.files, unfolded).map(file => (
                    <Row key={file.path} file={file} onOpen={onOpen} />
                ))}
            </div>
            {hidden > 0 && (
                <button
                    type="button"
                    className={styles.more}
                    aria-expanded={unfolded}
                    aria-controls={rows}
                    onClick={() => setUnfolded(value => !value)}
                >
                    <span className={styles.icon} aria-hidden>
                        {unfolded ? <ChevronUp /> : <ChevronDown />}
                    </span>
                    <Text variant="xs" color="secondary">
                        {chevronWords(changes, unfolded)}
                    </Text>
                </button>
            )}
        </ComposerBanner>
    );
}

/**
 * The plate over the message box after a run that changed files (Stage 9 of `.briefback/git-integration/plan.md`, in the manner of bb's): `Last run · 7 files +152 −22`, the first five files with
 * the letter of what happened to each and their lines, and a chevron for the rest. Only what that run changed: the daemon took two trees of the chat's place around the run's turn
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
