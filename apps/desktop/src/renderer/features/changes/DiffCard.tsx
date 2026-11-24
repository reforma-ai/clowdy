import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
import { CopyButton } from '@clowdy/components/CopyButton';
import { Separator } from '@clowdy/components/Separator';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { DiffView } from '@clowdy/file-manager/react';
import { ChevronDown, ChevronRight } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { type CSSProperties, useEffect, useRef, useState } from 'react';

import { useAddToChat } from '../chats/useAddToChat';
import { CARD_TEXT, type CardBody, cardBody, estimatedLines, needsSides } from './cardView';
import styles from './DiffCard.module.css';
import { sidesKey } from './fileSides';
import { CHANGE_KIND_VIEW, splitPath } from './gitSummary';
import { useNearViewport } from './useNearViewport';

import type { GitChangedFile } from '@clowdy/protocol';
import type { PlaceChanges } from './PlaceChanges';

/** The added and removed lines of a file as its header shows them, in the colours of the tool cards: nothing for a file whose lines were not counted. */
function LineCounts({ file }: { file: GitChangedFile }) {
    if (file.additions === undefined || file.deletions === undefined) return null;

    return (
        <span className={styles.counts} aria-label={`${file.additions} added, ${file.deletions} removed`}>
            <Text variant="xs" color="success">{`+${file.additions}`}</Text>
            <Text variant="xs" color="danger">{`−${file.deletions}`}</Text>
        </span>
    );
}

/** The path of a file in the card header: the folder dimmed and the name strong. A path too long for its room is cut at its start, so the name stays. */
function PathLabel({ path }: { path: string }) {
    const { folder, name } = splitPath(path);

    return (
        <span className={styles.path} dir="rtl" title={path}>
            <bdi dir="ltr">
                {folder && <Text color="secondary">{folder}</Text>}
                <Text weight="medium">{name}</Text>
            </bdi>
        </span>
    );
}

/** What stands in an open card where there is no diff: a word, centred. */
function Note({ children }: { children: string }) {
    return <p className={styles.note}>{children}</p>;
}

/** The body of an open card for what is known of its file. */
function Body({ body, file, onRetry }: { body: CardBody; file: GitChangedFile; onRetry: () => void }) {
    // Words selected in the diff go to the chat with the file's path and their lines of the new text.
    const addToChat = useAddToChat(() => file.path);

    switch (body.kind) {
        case 'binary':
            return <Note>{CARD_TEXT.binary}</Note>;
        case 'tooLarge':
            return <Note>{CARD_TEXT.tooLarge}</Note>;
        case 'note':
            return <Note>{body.text}</Note>;
        case 'error':
            return (
                <div className={styles.note} title={body.message}>
                    {CARD_TEXT.error}
                    <Button variant="ghost" color="secondary" size="xs" onPress={onRetry}>
                        Try again
                    </Button>
                </div>
            );
        case 'loading':
            // The box the diff will take, so the list does not move when the text comes in.
            return (
                <div className={styles.loading} style={{ '--diff-lines': estimatedLines(file) } as CSSProperties}>
                    <Spinner size="xs" aria-label="Loading the file" />
                </div>
            );
        case 'diff':
            return (
                <DiffView
                    lazy
                    className={styles.diff}
                    path={file.path}
                    original={body.original}
                    modified={body.modified}
                    extensions={addToChat}
                    estimatedLines={estimatedLines(file)}
                />
            );
    }
}

/**
 * One changed file of the list: a header with a chevron, the file's path (the folder dimmed, the name strong, cut at the start when it does not fit), what happened to it
 * (added, modified, deleted, renamed, with the old path of a rename under it), a button that copies the path, its added and removed lines, and a divider and `Viewed` checkbox; and, when it is
 * open, the diff of its two texts. Ticking `Viewed` shuts the card and unticking opens it (the model decides, and the tick shows before the daemon has answered). Its texts are asked of the cache while the card is near the scroller's edge and open, and not before, and a read that has not begun is
 * let go of when it stops being near, so a list of hundreds costs what is on screen; the header sticks to the top of the list while its diff scrolls. A card far from the edge is
 * an empty box of the height it had when it went far, or of the height it will likely take when it was never built, so the list scrolls as if it were all there. `eager` builds it
 * before the scroller has said where it is: the cards at the top of the list, which are on screen at once.
 */
export function DiffCard({
    model,
    file,
    eager = false,
}: {
    model: PlaceChanges;
    file: GitChangedFile;
    eager?: boolean;
}) {
    const open = !model.isFolded(file);
    const viewed = model.isViewed(file);
    const [element, setElement] = useState<HTMLElement | null>(null);
    const { near, known, height } = useNearViewport(element);
    // Whether the focus is in the card: a card is not emptied under a focused control, which would drop the focus to the page.
    const [focused, setFocused] = useState(false);
    // An eager card is built before the scroller has said where it is; its texts still wait for that.
    const built = near || focused || (eager && !known);
    // Whether the card was open when it was last built: the height it had then stands for it only while that is still so.
    const builtOpen = useRef<boolean | undefined>(undefined);
    const request = model.requestOf(file);
    const key = sidesKey(request);
    const entry = model.sides.entryOf(request);
    // The texts of the file as they were last read stay on show while another revision of it is on its way, and are not looked for again if the cache let go of them meanwhile.
    const previous = model.sides.latestOf(request);
    const wanted = open && near && needsSides(file) && previous?.revision !== file.revision;

    useEffect(() => {
        if (!wanted) return;

        model.sides.want(request);

        // A read that still waits for its turn when the card is shut, far from the screen, edited or gone is not made.
        return () => model.sides.drop(request);
    }, [wanted, key, model]);

    useEffect(() => {
        if (built) builtOpen.current = open;
    }, [built, open]);

    const kind = CHANGE_KIND_VIEW[file.kind];
    const renamedFrom =
        (file.kind === 'renamed' || file.kind === 'copied') && file.oldPath !== undefined ? file.oldPath : undefined;
    const Chevron = open ? ChevronDown : ChevronRight;
    // An empty card is the size it had when it went far, while it is as open as it was then, or the size it will likely take.
    const kept = height !== undefined && builtOpen.current === open ? height : undefined;
    const box = built
        ? undefined
        : ((kept === undefined ? { '--diff-lines': estimatedLines(file) } : { height: kept }) as CSSProperties);

    // The card is one element whether it is built or empty, so the scroller's anchoring keeps a card on screen in its place while the cards around it change their height.
    return (
        <div
            ref={setElement}
            role="group"
            className={cn(styles.card, !built && styles.placeholder)}
            style={box}
            data-card={file.path}
            data-open={open || undefined}
            aria-label={file.path}
            onFocus={() => setFocused(true)}
            onBlur={event => setFocused(event.currentTarget.contains(event.relatedTarget))}
        >
            {built && (
                <>
                    <div className={styles.header}>
                        <Button
                            variant="transparent"
                            size="sm"
                            className={styles.toggle}
                            contentClassName={styles.toggleContent}
                            aria-expanded={open}
                            aria-label={`${open ? 'Fold' : 'Unfold'} ${file.path}`}
                            onPress={() => model.toggleFolded(file)}
                        >
                            <Chevron className={styles.chevron} aria-hidden="true" />
                            <Text
                                variant="xs"
                                weight="medium"
                                color={kind.color}
                                className={styles.kind}
                                title={kind.label}
                                aria-label={kind.label}
                            >
                                {kind.glyph}
                            </Text>
                            <span className={styles.title}>
                                <PathLabel path={file.path} />
                                {renamedFrom !== undefined && (
                                    <Text
                                        variant="xs"
                                        color="secondary"
                                        truncate
                                        className={styles.from}
                                        title={renamedFrom}
                                    >{`Renamed from ${renamedFrom}`}</Text>
                                )}
                            </span>
                        </Button>
                        <CopyButton
                            value={file.path}
                            size="xs"
                            variant="filling"
                            color="secondary"
                            tooltip="Copy path"
                            aria-label={`Copy the path of ${file.path}`}
                        />
                        <LineCounts file={file} />
                        <Separator orientation="vertical" spacing={0} className={styles.divider} aria-hidden="true" />
                        <Checkbox
                            size="sm"
                            className={styles.viewed}
                            isSelected={viewed}
                            aria-label={`Viewed ${file.path}`}
                            onChange={selected => void model.setViewed(file, selected)}
                        >
                            <Text variant="xs" color="secondary">
                                Viewed
                            </Text>
                        </Checkbox>
                    </div>
                    {open && (
                        <div className={styles.body}>
                            <Body
                                body={cardBody(file, entry, previous)}
                                file={file}
                                onRetry={() => model.sides.retry(request)}
                            />
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
