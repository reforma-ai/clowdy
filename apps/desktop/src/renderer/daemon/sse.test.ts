import { describe, expect, it } from 'vitest';

import { SseParser } from './sse';

describe('SseParser', () => {
    it('reads a frame with its event name, id and data', () => {
        const frames = new SseParser().push('event: clowdy\nid: 7\ndata: {"cursor":7}\n\n');

        expect(frames).toEqual([{ event: 'clowdy', id: '7', data: '{"cursor":7}' }]);
    });

    it('joins frames that are cut anywhere, even inside a line', () => {
        const parser = new SseParser();
        const text = 'event: clowdy\ndata: one\n\nevent: clowdy\ndata: two\n\n';
        const frames = [...text].flatMap(character => parser.push(character));

        expect(frames.map(frame => frame.data)).toEqual(['one', 'two']);
    });

    it('accepts \\r\\n and lone \\r line ends, even when the pair is split between chunks', () => {
        const parser = new SseParser();

        expect(parser.push('data: a\r\n\r\ndata: b\r\rdata: c\r\n\r\n').map(frame => frame.data)).toEqual([
            'a',
            'b',
            'c',
        ]);
        expect(
            [...parser.push('data: d\r'), ...parser.push('\n\r'), ...parser.push('\n')].map(frame => frame.data)
        ).toEqual(['d']);
    });

    it('joins several data lines with a newline and keeps a space only after the first one', () => {
        expect(new SseParser().push('data: first\ndata:  second\n\n')[0].data).toBe('first\n second');
    });

    it('drops comments and heartbeats, and a frame without data', () => {
        const parser = new SseParser();

        expect(parser.push(': keep-alive\n\n')).toEqual([]);
        expect(parser.push('event: clowdy\n\n')).toEqual([]);
        expect(parser.push('data: after\n\n').map(frame => frame.data)).toEqual(['after']);
    });

    it('does not carry an event name or id over to the next frame', () => {
        const frames = new SseParser().push('event: clowdy\nid: 1\ndata: a\n\ndata: b\n\n');

        expect(frames[1]).toEqual({ event: 'message', data: 'b', id: undefined });
    });
});
