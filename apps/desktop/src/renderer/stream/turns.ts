import { COMPACT_TOOL } from './compaction';
import { isSubagentTool } from './subagents';

import type { StreamItem } from '@clowdy/protocol';

/** An item as it is. */
export type ItemBlock = Extract<StreamBlock, { kind: 'item' }>;

/** Tool calls that follow one another, and the thoughts between them, drawn under one line that tells what the calls did (`ToolGroup`). */
export interface ToolRun {
    kind: 'tools';
    key: string;
    items: StreamItem[];
}

/**
 * What a stream draws, in order: an item as it is, the work of a finished turn folded under one line, or a run of tool calls under one line. `answer` marks
 * the final answer of a finished turn (a turn still running has none yet). `foldFinishedWork` makes the first two; `groupToolRuns` adds the third.
 */
export type StreamBlock =
    | { kind: 'item'; item: StreamItem; answer?: true }
    | { kind: 'worked'; key: string; label: string; items: StreamItem[] }
    | ToolRun;

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

function plain(turn: StreamItem[], answer?: StreamItem): StreamBlock[] {
    return turn.map(item => (item === answer ? { kind: 'item', item, answer: true } : { kind: 'item', item }));
}

/**
 * A turn that is over keeps what the person said and the answer, and folds the work between them (tool calls,
 * notes and messages on the way) under one "Worked for" line. Errors and questions stay out of the fold.
 */
function foldTurn(turn: StreamItem[], answered: boolean): StreamBlock[] {
    const head = turn[0].body.kind === 'user' ? 1 : 0;
    const answerAt = turn.findLastIndex(isAnswer);
    const answer = turn[answerAt];

    // The latest turn without an answer (stopped, failed) stays open; a turn the person has since written past folds all.
    if (answerAt < 0 && !answered) return plain(turn);

    const end = answerAt < 0 ? turn.length : answerAt;
    const between = turn.slice(head, end);
    const work = between.filter(item => !needsAttention(item));

    if (work.length === 0) return plain(turn, answer);

    const label = workedForLabel(turn[0].at, (answer ?? turn.at(-1)!).at);

    return [
        ...plain(turn.slice(0, head)),
        { kind: 'worked', key: `worked-${ work[0].id }`, label, items: work },
        ...plain(between.filter(needsAttention)),
        ...plain(turn.slice(end), answer),
    ];
}

/** The blocks that carry a row of message actions: what the person wrote (not an agent's or a thread's words) and the final answer of a finished turn. */
export function hasMessageActions(block: StreamBlock): block is Extract<StreamBlock, { kind: 'item' }> {
    if (block.kind !== 'item') return false;

    const { body } = block.item;

    return block.answer === true || (body.kind === 'user' && !body.from);
}

/**
 * The item a fork's divider follows: the one whose `seq` is `atSeq` (the answer the fork was made at), else, when that number is missing from the stream,
 * the last item before it. Nothing when the stream does not reach `atSeq` yet, or has nothing before it.
 */
export function forkPointId(items: readonly StreamItem[], atSeq: number): string | undefined {
    const exact = items.find(item => item.seq === atSeq);

    if (exact) return exact.id;

    return items.some(item => item.seq > atSeq) ? items.findLast(item => item.seq < atSeq)?.id : undefined;
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

/** What a group may hold: a call that is not a sub-agent's card or a compaction (lines of their own), and what the agent thought. */
const isRunItem = (item: StreamItem) => item.body.kind === 'reasoning' || (item.body.kind === 'tool' && item.body.name !== COMPACT_TOOL && !isSubagentTool(item.body.name));

/**
 * Puts tool calls that follow one another under one block, with the thoughts of the agent between them: a run of two or more calls becomes one `tools`
 * block; a call alone stays as it is, since a line with nothing more to say than the call is no gain, and so do thoughts with no call of two beside them.
 * Anything else (a message, a note, a card of a sub-agent) ends the run.
 */
export function groupToolRuns(blocks: readonly ItemBlock[]): (ItemBlock | ToolRun)[];
export function groupToolRuns(blocks: readonly StreamBlock[]): StreamBlock[];
export function groupToolRuns(blocks: readonly StreamBlock[]): StreamBlock[] {
    const grouped: StreamBlock[] = [];
    let run: ItemBlock[] = [];

    const flush = () => {
        if (run.filter(block => block.item.body.kind === 'tool').length >= 2) grouped.push({ kind: 'tools', key: `tools-${ run[0].item.id }`, items: run.map(block => block.item) });
        else grouped.push(...run);

        run = [];
    };

    for (const block of blocks) {
        if (block.kind === 'item' && !block.answer && isRunItem(block.item)) {
            run.push(block);

            continue;
        }

        flush();
        grouped.push(block);
    }

    flush();

    return grouped;
}
