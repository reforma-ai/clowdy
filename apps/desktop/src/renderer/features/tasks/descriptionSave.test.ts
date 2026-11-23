import { describe, expect, it, vi } from 'vitest';

import { LatestSaver, onlyTicksChanged } from './descriptionSave';

describe('onlyTicksChanged', () => {
    it('is true when a box is ticked or unticked and nothing else changed', () => {
        expect(onlyTicksChanged('- [ ] one\n- [ ] two', '- [x] one\n- [ ] two')).toBe(true);
        expect(onlyTicksChanged('- [x] one\n- [x] two', '- [ ] one\n- [x] two')).toBe(true);
        expect(onlyTicksChanged('- [ ] one\n- [ ] two', '- [x] one\n- [x] two')).toBe(true);
    });

    it('reads every kind of list marker and an upper case X, and nested items', () => {
        expect(onlyTicksChanged('* [ ] a\n+ [ ] b\n1. [ ] c\n  - [ ] d', '* [x] a\n+ [X] b\n1. [x] c\n  - [x] d')).toBe(
            true
        );
    });

    it('keeps the text around the boxes in the comparison: a word typed with a tick is typing', () => {
        expect(onlyTicksChanged('- [ ] one', '- [x] one!')).toBe(false);
        expect(onlyTicksChanged('Steps:\n\n- [ ] one', 'Steps\n\n- [x] one')).toBe(false);
    });

    it('is false for text that is the same, and for brackets that are not a checklist line', () => {
        expect(onlyTicksChanged('- [ ] one', '- [ ] one')).toBe(false);
        expect(onlyTicksChanged('see [ ] here', 'see [x] here')).toBe(false);
        expect(onlyTicksChanged('[ ] one', '[x] one')).toBe(false);
    });
});

/** A save the test settles by hand, so what the saver does while one is on its way can be looked at. */
function deferredSend() {
    const waiting: { text: string; settle: (taken: boolean) => void }[] = [];
    const send = vi.fn((text: string) => new Promise<boolean>(resolve => void waiting.push({ text, settle: resolve })));

    return { send, waiting };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('LatestSaver', () => {
    it('sends a text at once and is busy until it is taken', async () => {
        const { send, waiting } = deferredSend();
        const saver = new LatestSaver(send, vi.fn());
        const done = saver.save('one');

        expect(send).toHaveBeenCalledExactlyOnceWith('one');
        expect(saver.isBusy).toBe(true);

        waiting[0].settle(true);
        await done;

        expect(saver.isBusy).toBe(false);
    });

    it('sends one text at a time, and after the one on its way only the newest of those that came meanwhile', async () => {
        const { send, waiting } = deferredSend();
        const saver = new LatestSaver(send, vi.fn());
        const done = saver.save('one');

        void saver.save('two');
        void saver.save('three');
        void saver.save('four');

        expect(send).toHaveBeenCalledTimes(1);

        waiting[0].settle(true);
        await flush();

        expect(send.mock.calls.map(([text]) => text)).toEqual(['one', 'four']);

        waiting[1].settle(true);
        await done;

        expect(saver.isBusy).toBe(false);
    });

    it('does not send again the text it sent last', async () => {
        const send = vi.fn(async (_text: string) => true);
        const saver = new LatestSaver(send, vi.fn());

        await saver.save('one');
        await saver.save('one');
        await saver.save('two');
        await saver.save('two');

        expect(send.mock.calls.map(([text]) => text)).toEqual(['one', 'two']);
    });

    it('sends the text again when the project showed something else since: someone else changed it', async () => {
        const send = vi.fn(async (_text: string) => true);
        const saver = new LatestSaver(send, vi.fn());

        await saver.save('one');
        saver.noteStored('one');
        await saver.save('one');
        expect(send).toHaveBeenCalledTimes(1);

        saver.noteStored('written by an agent');
        await saver.save('one');
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('drops what waits when a save is refused, and tells the caller once', async () => {
        const { send, waiting } = deferredSend();
        const onRefused = vi.fn();
        const saver = new LatestSaver(send, onRefused);
        const done = saver.save('one');

        void saver.save('two');
        waiting[0].settle(false);
        await done;

        expect(send).toHaveBeenCalledTimes(1);
        expect(onRefused).toHaveBeenCalledTimes(1);
        expect(saver.isBusy).toBe(false);

        // The text that was refused is not the one sent last, so the person may try it again.
        const again = saver.save('one');

        expect(send).toHaveBeenCalledTimes(2);
        waiting[1].settle(true);
        await again;
    });

    it('is not left busy by a send that throws', async () => {
        const saver = new LatestSaver(async () => {
            throw new Error('offline');
        }, vi.fn());

        await expect(saver.save('one')).rejects.toThrow('offline');
        expect(saver.isBusy).toBe(false);
    });
});
