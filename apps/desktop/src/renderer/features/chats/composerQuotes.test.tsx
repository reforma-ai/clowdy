// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
    dropReplyQuote,
    replyQuoteOf,
    restoreReplyQuote,
    setReplyQuote,
    takeReplyQuote,
    useReplyQuote,
} from './composerQuotes';

import type { ReplyMessage } from '../../stream/MessageActions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const person: ReplyMessage = { role: 'user', text: 'Use the blue one' };
const answer: ReplyMessage = { role: 'assistant', text: 'Done.' };

afterEach(() => {
    for (const key of ['a', 'b']) dropReplyQuote(key);
});

describe('the message a box replies to', () => {
    it('is kept per box, each under its own key', () => {
        setReplyQuote('a', person);
        setReplyQuote('b', answer);

        expect(replyQuoteOf('a')).toBe(person);
        expect(replyQuoteOf('b')).toBe(answer);

        dropReplyQuote('a');

        expect(replyQuoteOf('a')).toBeUndefined();
        expect(replyQuoteOf('b')).toBe(answer);
    });

    it('is one message at a time: another reply takes the place of the first', () => {
        setReplyQuote('a', person);
        setReplyQuote('a', answer);

        expect(replyQuoteOf('a')).toBe(answer);
    });

    it('is handed over for sending, and the box has none after', () => {
        setReplyQuote('a', person);

        expect(takeReplyQuote('a')).toBe(person);
        expect(replyQuoteOf('a')).toBeUndefined();
        expect(takeReplyQuote('a')).toBeUndefined();
    });

    it('comes back when its message did not go', () => {
        restoreReplyQuote('a', person);

        expect(replyQuoteOf('a')).toBe(person);
    });

    it('does not come back over a message the person picked meanwhile', () => {
        setReplyQuote('a', answer);
        restoreReplyQuote('a', person);

        expect(replyQuoteOf('a')).toBe(answer);
    });

    it('tells a component that reads it, and only the key it reads', async () => {
        const container = document.createElement('div');
        const root = createRoot(container);
        const draws: Array<string | undefined> = [];

        function Probe() {
            draws.push(useReplyQuote('a')?.text);

            return null;
        }

        await act(async () => root.render(<Probe />));
        await act(async () => setReplyQuote('a', person));
        await act(async () => setReplyQuote('b', answer));
        await act(async () => dropReplyQuote('a'));
        act(() => root.unmount());

        expect(draws).toEqual([undefined, 'Use the blue one', undefined]);
    });
});
