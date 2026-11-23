// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { quoteIntoComposer, registerComposer, useHasComposer, useRegisterComposer } from './composerBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('composerBridge', () => {
    it('says no box took the words when none is registered', () => {
        expect(quoteIntoComposer('a')).toBe(false);
    });

    it('hands the words to the box that is registered', () => {
        const quote = vi.fn();
        const unregister = registerComposer(quote);

        expect(quoteIntoComposer('some words')).toBe(true);
        expect(quote).toHaveBeenCalledExactlyOnceWith('some words');

        unregister();
    });

    it('asks the box registered last, and the one before it again once that one goes', () => {
        const first = vi.fn();
        const second = vi.fn();
        const unregisterFirst = registerComposer(first);
        const unregisterSecond = registerComposer(second);

        quoteIntoComposer('one');
        expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);

        unregisterSecond();
        quoteIntoComposer('two');
        expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1]);

        unregisterFirst();
        expect(quoteIntoComposer('three')).toBe(false);
    });

    it('lets go of a box once, however many times it is told to', () => {
        const first = vi.fn();
        const unregisterFirst = registerComposer(first);
        const unregisterSecond = registerComposer(vi.fn());

        unregisterSecond();
        unregisterSecond();
        quoteIntoComposer('words');

        expect(first).toHaveBeenCalledOnce();
        unregisterFirst();
    });

    describe('in a page', () => {
        let container: HTMLDivElement;
        let root: Root;
        let seen: boolean[];

        function Watcher() {
            seen.push(useHasComposer());

            return null;
        }

        function Box({ quote }: { quote: ((text: string) => void) | undefined }) {
            useRegisterComposer(quote);

            return null;
        }

        beforeEach(() => {
            container = document.createElement('div');
            document.body.append(container);
            root = createRoot(container);
            seen = [];
        });

        afterEach(async () => {
            await act(async () => root.unmount());
            container.remove();
        });

        it('registers a box while it is mounted and lets it go when it unmounts', async () => {
            const quote = vi.fn();

            await act(async () => root.render(<><Watcher /><Box quote={ quote } /></>));
            expect(seen.at(-1)).toBe(true);
            expect(quoteIntoComposer('words')).toBe(true);
            expect(quote).toHaveBeenCalledExactlyOnceWith('words');

            await act(async () => root.render(<Watcher />));
            expect(seen.at(-1)).toBe(false);
            expect(quoteIntoComposer('more')).toBe(false);
            expect(quote).toHaveBeenCalledOnce();
        });

        it('registers nothing for a box that takes no quotes (the box of an edit frame)', async () => {
            await act(async () => root.render(<><Watcher /><Box quote={ undefined } /></>));

            expect(seen.at(-1)).toBe(false);
            expect(quoteIntoComposer('words')).toBe(false);
        });

        it('calls the box\'s latest quote while staying registered once', async () => {
            const stale = vi.fn();
            const latest = vi.fn();

            await act(async () => root.render(<Box quote={ stale } />));
            await act(async () => root.render(<Box quote={ latest } />));

            expect(quoteIntoComposer('words')).toBe(true);
            expect(stale).not.toHaveBeenCalled();
            expect(latest).toHaveBeenCalledExactlyOnceWith('words');

            await act(async () => root.render(<Watcher />));
            expect(quoteIntoComposer('again')).toBe(false);
        });
    });
});
