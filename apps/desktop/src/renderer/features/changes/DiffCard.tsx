import { Button } from '@clowdy/components/Button';
import { CopyButton } from '@clowdy/components/CopyButton';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { DiffView } from '@clowdy/file-manager/react';
import { ChevronDown, ChevronRight } from '@clowdy/icons/14';
import { useEffect, useState, type CSSProperties } from 'react';

import { CARD_TEXT, cardBody, estimatedLines, needsSides, type CardBody } from './cardView';
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
        <span className={ styles.counts } aria-label={ `${ file.additions } added, ${ file.deletions } removed` }>
            <Text variant="xs" color="success">{ `+${ file.additions }` }</Text>
            <Text variant="xs" color="danger">{ `−${ file.deletions }` }</Text>
        </span>
    );
}

/** The path of a file as the card's header and the sidebar write it: the folder dimmed and the name strong. A path too long for its room is cut at its start, so the name stays. */
function PathLabel({ path }: { path: string }) {
    const { folder, name } = splitPath(path);

    return (
        <span className={ styles.path } dir="rtl" title={ path }>
            <bdo dir="ltr">
                { folder && <Text color="secondary">{ folder }</Text> }
                <Text weight="medium">{ name }</Text>
            </bdo>
        </span>
    );
}

/** What stands in an open card where there is no diff: a word, centred. */
function Note({ children }: { children: string }) {
    return <p className={ styles.note }>{ children }</p>;
}

/** The body of an open card for what is known of its file. */
function Body({ body, file, onRetry }: { body: CardBody; file: GitChangedFile; onRetry: () => void }) {
    switch (body.kind) {
        case 'binary':
            return <Note>{ CARD_TEXT.binary }</Note>;
        case 'tooLarge':
            return <Note>{ CARD_TEXT.tooLarge }</Note>;
        case 'note':
            return <Note>{ body.text }</Note>;
        case 'error':
            return (
                <div className={ styles.note } title={ body.message }>
                    { CARD_TEXT.error }
                    <Button variant="ghost" color="secondary" size="xs" onPress={ onRetry }>Try again</Button>
                </div>
            );
        case 'loading':
            // The box the diff will take, so the list does not move when the text comes in.
            return (
                <div className={ styles.loading } style={ { '--diff-lines': estimatedLines(file) } as CSSProperties }>
                    <Spinner size="xs" aria-label="Loading the file" />
                </div>
            );
        case 'diff':
            return <DiffView lazy className={ styles.diff } path={ file.path } original={ body.original } modified={ body.modified } estimatedLines={ estimatedLines(file) } />;
    }
}

/**
 * One changed file of the list: a header with a chevron, the file's path (the folder dimmed, the name strong, cut at the start when it does not fit), what happened to it
 * (added, modified, deleted, renamed, with the old path of a rename under it), its added and removed lines and a button that copies the path; and, when it is open, the diff of its
 * two texts. A card is open until it is shut. Its texts are asked of the cache while the card is near the scroller's edge and open, and not before, and a read that has not begun is
 * let go of when it stops being near, so a list of hundreds costs what is on screen; the header sticks to the top of the list while its diff scrolls.
 */
export function DiffCard({ model, file }: { model: PlaceChanges; file: GitChangedFile }) {
    const open = !model.isFolded(file.path);
    const [element, setElement] = useState<HTMLElement | null>(null);
    const near = useNearViewport(element);
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

    const kind = CHANGE_KIND_VIEW[file.kind];
    const renamedFrom = (file.kind === 'renamed' || file.kind === 'copied') && file.oldPath !== undefined ? file.oldPath : undefined;
    const Chevron = open ? ChevronDown : ChevronRight;

    return (
        <div ref={ setElement } role="group" className={ styles.card } data-card={ file.path } data-open={ open || undefined } aria-label={ file.path }>
            <div className={ styles.header }>
                <Button
                    variant="transparent"
                    size="sm"
                    className={ styles.toggle }
                    contentClassName={ styles.toggleContent }
                    aria-expanded={ open }
                    aria-label={ `${ open ? 'Fold' : 'Unfold' } ${ file.path }` }
                    onPress={ () => model.toggleFolded(file.path) }
                >
                    <Chevron className={ styles.chevron } aria-hidden="true" />
                    <Text variant="xs" weight="medium" color={ kind.color } className={ styles.kind } title={ kind.label } aria-label={ kind.label }>{ kind.glyph }</Text>
                    <span className={ styles.title }>
                        <PathLabel path={ file.path } />
                        { renamedFrom !== undefined && <Text variant="xs" color="secondary" truncate className={ styles.from } title={ renamedFrom }>{ `Renamed from ${ renamedFrom }` }</Text> }
                    </span>
                    <LineCounts file={ file } />
                </Button>
                <CopyButton value={ file.path } size="sm" variant="filling" color="secondary" tooltip="Copy path" aria-label={ `Copy the path of ${ file.path }` } />
            </div>
            { open && (
                <div className={ styles.body }>
                    <Body body={ cardBody(file, entry, previous) } file={ file } onRetry={ () => model.sides.retry(request) } />
                </div>
            ) }
        </div>
    );
}
