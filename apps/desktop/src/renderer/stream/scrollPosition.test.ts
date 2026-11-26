// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { captureScrollPosition, restoreScrollPosition } from './scrollPosition';

const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top }) as DOMRect;

function scroller(top: number) {
    const scroll = document.createElement('div');
    Object.defineProperties(scroll, {
        clientHeight: { value: 400 },
        scrollHeight: { value: 1200 },
    });
    scroll.scrollTop = top;
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rect(100, 500));

    return scroll;
}

describe('reading position', () => {
    it('does not remember a fixed position at the end, so new messages can be followed', () => {
        expect(captureScrollPosition(scroller(800))).toBeUndefined();
        expect(captureScrollPosition(scroller(799.5))).toBeUndefined();
        expect(captureScrollPosition(scroller(750))).toBeUndefined();
        expect(captureScrollPosition(scroller(749))).toEqual({ top: 749 });
    });

    it('restores the same part of a message even when earlier content changes height', () => {
        const scroll = scroller(260);
        const old = document.createElement('div');
        old.dataset.turn = 'user';
        vi.spyOn(old, 'getBoundingClientRect').mockReturnValue(rect(-100, 50));
        const answer = document.createElement('div');
        answer.dataset.scrollAnchor = 'answer';
        vi.spyOn(answer, 'getBoundingClientRect').mockReturnValue(rect(60, 350));
        scroll.append(old, answer);

        const saved = captureScrollPosition(scroll)!;
        expect(saved).toEqual({ top: 260, anchor: { id: 'answer', offset: -40 } });

        const returned = scroller(0);
        const sameAnswer = document.createElement('div');
        sameAnswer.dataset.scrollAnchor = 'answer';
        vi.spyOn(sameAnswer, 'getBoundingClientRect').mockReturnValue(rect(220, 510));
        returned.append(sameAnswer);
        restoreScrollPosition(returned, saved);
        expect(returned.scrollTop).toBe(160);
    });

    it('keeps the top offset when no message is visible or the anchor was removed', () => {
        const scroll = scroller(310);
        expect(captureScrollPosition(scroll)).toEqual({ top: 310 });
        restoreScrollPosition(scroll, { top: 220, anchor: { id: 'deleted', offset: -20 } });
        expect(scroll.scrollTop).toBe(220);
    });

    it('does not anchor to an empty message or one hidden behind the composer', () => {
        const scroll = scroller(310);
        const empty = document.createElement('div');
        empty.dataset.scrollAnchor = 'empty';
        vi.spyOn(empty, 'getBoundingClientRect').mockReturnValue(rect(250, 250));
        const hidden = document.createElement('div');
        hidden.dataset.scrollAnchor = 'hidden';
        vi.spyOn(hidden, 'getBoundingClientRect').mockReturnValue(rect(390, 600));
        scroll.append(empty, hidden);
        expect(captureScrollPosition(scroll, 120)).toEqual({ top: 310 });
        vi.spyOn(hidden, 'getBoundingClientRect').mockReturnValue(rect(10, 600));
        expect(captureScrollPosition(scroll, 400)).toEqual({ top: 310 });
    });
});
