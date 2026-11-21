import type { StreamItem } from '@clowdy/protocol';

/** What one message of the person or of the agent may take; a longer one keeps its start and its end, where the point and the question usually are. */
const TEXT_HEAD = 2400;
const TEXT_TAIL = 800;
/** What the input and the result of one tool may take: the agent needs to know what was done, not the bytes. */
const TOOL_CHARS = 200;
/** The most the whole record takes (about ten thousand tokens). */
const TOTAL_CHARS = 40_000;
/** The first entries are kept whatever the size: the person's first message says what the work is. */
const KEPT_FIRST = 2;

const INTRO = [
    'Your earlier session in this conversation could not be opened again, so this session starts empty.',
    'Below is what Clowdy kept of the conversation: what the person wrote, what you answered, and the tools you used (their inputs and results are shortened or left out).',
    'Take it as the story so far. It tells you what you were working on, but the files and the tasks may have moved on since, so look before you rely on a detail.',
].join(' ');

function clip(text: string): string {
    const body = text.trim();

    return body.length > TEXT_HEAD + TEXT_TAIL ? `${ body.slice(0, TEXT_HEAD) }\n[…]\n${ body.slice(-TEXT_TAIL) }` : body;
}

function brief(value: unknown): string {
    if (value === undefined || value === null || value === '') {
        return '';
    }

    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
    const flat = text.replace(/\s+/g, ' ').trim();

    return flat.length > TOOL_CHARS ? `${ flat.slice(0, TOOL_CHARS - 1) }…` : flat;
}

/** One item as a line of the record, or nothing for an item that adds none. */
function entryOf(item: StreamItem): string | undefined {
    const { body } = item;

    switch (body.kind) {
        case 'user': {
            const files = body.attachments?.map(file => file.name).join(', ');

            return `Person: ${ [clip(body.text), files && `[files: ${ files }]`].filter(Boolean).join(' ') }`.trimEnd();
        }
        case 'assistant':
            return body.text.trim() ? `You: ${ clip(body.text) }` : undefined;
        case 'tool': {
            const input = brief(body.input);
            const result = body.error ? `failed: ${ brief(body.error) }` : brief(body.output);

            return `Tool ${ body.name } (${ body.state })${ input ? `: ${ input }` : '' }${ result ? ` → ${ result }` : '' }`;
        }
        // What the agent thought is not part of the story it is told again.
        case 'reasoning':
            return undefined;
        case 'note':
            return `Clowdy: ${ clip(body.text) }`;
        case 'question':
            return `You asked the person: ${ clip(body.text) }${ body.answer ? ` They answered: ${ clip(body.answer) }` : '' }`;
        case 'error':
            return `Error: ${ clip(body.text) }`;
    }
}

/**
 * The conversation as text for an agent that lost its own session, from the stream Clowdy keeps. `incoming` are the messages this turn
 * sends: the person's last messages that are among them are left out (the agent is about to get them anyway). A conversation longer than
 * the budget keeps its first entries and the newest ones, with a line that says how many were left out. Nothing to tell gives `undefined`.
 */
export function conversationRecord(items: StreamItem[], incoming: string[]): string | undefined {
    const earlier = [...items];

    while (earlier.length > 0) {
        const last = earlier[earlier.length - 1]!.body;

        if (last.kind !== 'user' || !incoming.some(message => message.includes(last.text))) {
            break;
        }

        earlier.pop();
    }

    const entries = earlier.flatMap(item => entryOf(item) ?? []);

    if (entries.length === 0) {
        return undefined;
    }

    const kept = new Set<number>();
    let size = 0;

    for (const index of [...entries.keys()].slice(0, KEPT_FIRST)) {
        kept.add(index);
        size += entries[index]!.length + 1;
    }

    for (let index = entries.length - 1; index >= 0 && size < TOTAL_CHARS; index--) {
        if (!kept.has(index)) {
            kept.add(index);
            size += entries[index]!.length + 1;
        }
    }

    const lines: string[] = [];
    let skipped = 0;

    for (const [index, entry] of entries.entries()) {
        if (kept.has(index)) {
            if (skipped > 0) {
                lines.push(`[${ skipped } entries in between are left out]`);
                skipped = 0;
            }

            lines.push(entry);
        }
        else {
            skipped++;
        }
    }

    return `${ INTRO }\n\n<earlier_conversation>\n${ lines.join('\n') }\n</earlier_conversation>`;
}
