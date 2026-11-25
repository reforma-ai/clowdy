import type { StreamItem, StreamItemBody } from '@clowdy/protocol';

/**
 * A card's question is a title, then paragraphs after blank lines: the facts and the "My pick: ..." line
 * (the card protocol of clowdy:semi-manual). A question without blank lines is all title.
 */
export function splitQuestion(text: string): { title: string; paragraphs: string[] } {
    const [title = '', ...paragraphs] = text
        .split(/\n\s*\n/)
        .map(part => part.trim())
        .filter(Boolean);

    return { title, paragraphs };
}

/** What the Skip button gives the agent: the person chose not to answer, and the agent decides the point itself (clowdy:semi-manual says so). */
export const SKIPPED_ANSWER = 'Skipped';

type QuestionItem = StreamItem & { body: Extract<StreamItemBody, { kind: 'question' }> };

/** The question the run waits on: the newest one that has neither an answer nor a state (stopped, withdrawn, expired). */
export function openQuestion(items: readonly StreamItem[]): QuestionItem['body'] | undefined {
    return items.findLast(
        (item): item is QuestionItem =>
            item.body.kind === 'question' && item.body.answer === undefined && item.body.state === undefined
    )?.body;
}
