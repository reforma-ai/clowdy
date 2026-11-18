import type { StreamItem } from '@clowdy/protocol';

/** What a stream draws, in order: an item as it is, or the work of a finished turn folded under one line. */
export type StreamBlock =
    | { kind: 'item'; item: StreamItem }
    | { kind: 'worked'; key: string; label: string; items: StreamItem[] };

/** "Worked for 25s", "Worked for 2m 5s", "Worked for 1h 10m". */
export function workedForLabel(startedAt: number, endedAt: number): string {
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return 'Worked';

    const seconds = Math.max(1, Math.round((endedAt - startedAt) / 1000));

    if (seconds < 60) return `Worked for ${ seconds }s`;

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) return seconds % 60 === 0 ? `Worked for ${ minutes }m` : `Worked for ${ minutes }m ${ seconds % 60 }s`;

    const hours = Math.floor(minutes / 60);

    return minutes % 60 === 0 ? `Worked for ${ hours }h` : `Worked for ${ hours }h ${ minutes % 60 }m`;
}

/** The answer of a turn: its last message with text in it, written out. */
const isAnswer = (item: StreamItem) => item.body.kind === 'assistant' && item.body.done && item.body.text.trim() !== '';

/** What the person must see even in a turn that is over: a failure, and a question put to them. */
const needsAttention = (item: StreamItem) => item.body.kind === 'error' || item.body.kind === 'question';

function plain(turn: StreamItem[]): StreamBlock[] {
    return turn.map(item => ({ kind: 'item', item }));
}

/**
 * A turn that is over keeps what the person said and the answer, and folds the work between them (tool calls,
 * notes and messages on the way) under one "Worked for" line. Errors and questions stay out of the fold.
 */
function foldTurn(turn: StreamItem[], answered: boolean): StreamBlock[] {
    const head = turn[0].body.kind === 'user' ? 1 : 0;
    const answerAt = turn.findLastIndex(isAnswer);

    // The latest turn without an answer (stopped, failed) stays open; a turn the person has since written past folds all.
    if (answerAt < 0 && !answered) return plain(turn);

    const end = answerAt < 0 ? turn.length : answerAt;
    const between = turn.slice(head, end);
    const work = between.filter(item => !needsAttention(item));

    if (work.length === 0) return plain(turn);

    const label = workedForLabel(turn[0].at, (turn[answerAt] ?? turn.at(-1)!).at);

    return [
        ...plain(turn.slice(0, head)),
        { kind: 'worked', key: `worked-${ work[0].id }`, label, items: work },
        ...plain(between.filter(needsAttention)),
        ...plain(turn.slice(end)),
    ];
}

/**
 * Splits a stream into turns, each starting at a message of the person's, and folds the work of the ones that are over.
 * `active`: the run is still going, or waiting for the person, so the latest turn stays as it is.
 */
export function foldFinishedWork(items: readonly StreamItem[], active: boolean): StreamBlock[] {
    const turns: StreamItem[][] = [];

    for (const item of items) {
        if (item.body.kind === 'user' || turns.length === 0) turns.push([item]);
        else turns.at(-1)!.push(item);
    }

    return turns.flatMap((turn, index) => {
        const latest = index === turns.length - 1;

        return latest && active ? plain(turn) : foldTurn(turn, !latest);
    });
}
