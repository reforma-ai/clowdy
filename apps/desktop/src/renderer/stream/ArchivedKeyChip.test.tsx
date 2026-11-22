// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureTransport } from '../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../stores';
import { Markdown } from './Markdown';
import { StreamLinksContext, type StreamLinks } from './StreamLinks';
import { UserBubble } from './UserBubble';

import type { TaskDetail } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * A key of a task that was archived before the window opened: the board and the window's memory of archived tasks have no such task, so the key is text until `ProjectState.taskOfKey`
 * has read it from the daemon, and then it is a chip. The daemon here answers when the test lets it. The app's build wraps every component in `observer`; the test build has no such
 * plugin, so `UserBubble`, which calls `taskOfKey` while it renders, is wrapped here by hand, and a Markdown text, whose code span calls it in a component of its own, is drawn again
 * by hand once the read is over.
 */

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let daemon: FixtureTransport;
/** The keys the window asked the daemon for, in order, and the replies it is waiting for. */
let asked: string[];
let replies: (() => void)[];
/** The daemon cannot be reached: the replies it gives are failures. */
let offline: boolean;

/** Lets the daemon answer every read the window is waiting for, and lets the window take the answers in. */
const answer = () => act(async () => {
    replies.splice(0).forEach(reply => reply());
    await new Promise(resolve => setTimeout(resolve, 0));
});

const chips = () => [...container.querySelectorAll<HTMLElement>('button[title]')].map(chip => chip.textContent);

beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    asked = [];
    replies = [];
    offline = false;
    daemon = new FixtureTransport();

    const read = daemon.getTaskDetailByKey.bind(daemon);

    daemon.getTaskDetailByKey = (projectId, key) => {
        asked.push(key);

        return new Promise<TaskDetail>((resolve, reject) => {
            replies.push(() => (offline ? reject(new Error('offline')) : read(projectId, key).then(resolve, reject)));
        });
    };
    store = new RootStore(daemon);
    await store.load();
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
});

const linksOf = (): StreamLinks => ({ taskOfKey: key => store.selectedProject!.taskOfKey(key) });

const drawBubble = (text: string) => {
    const Bubble = observer(UserBubble);

    return act(async () => {
        reactRoot.render(
            <RootStoreProvider value={ store }>
                <StreamLinksContext value={ linksOf() }><Bubble text={ text } at={ 0 } /></StreamLinksContext>
            </RootStoreProvider>
        );
    });
};

describe('a key of an archived task the window has not seen', () => {
    it('is words in a message of the person until the read is over, then a chip, with no redraw by hand', async () => {
        await drawBubble('Take CAR-38 next, then CAR-999');

        expect(chips()).toEqual([]);
        expect(container.textContent).toContain('CAR-38');
        expect(asked).toEqual(['CAR-38', 'CAR-999']);

        await answer();

        expect(chips()).toEqual(['CAR-38']);
        expect(container.querySelector('button[title]')?.getAttribute('title')).toBe(store.selectedProject!.archivedKnown.get('t-38')?.title);
        // The key nobody has stays words, and each key was asked for once however often the message was drawn.
        expect(container.textContent).toContain('CAR-999');
        expect(asked).toEqual(['CAR-38', 'CAR-999']);
    });

    it('is a chip in a code span of Markdown once the read is over and the text is drawn again, and code that is not a key asks nothing', async () => {
        const draw = () => act(async () => {
            reactRoot.render(
                <RootStoreProvider value={ store }>
                    <StreamLinksContext value={ linksOf() }><Markdown text="Read `CAR-39` and `npm run build` first" /></StreamLinksContext>
                </RootStoreProvider>
            );
        });

        await draw();

        expect(container.querySelectorAll('[data-streamdown="inline-code"]')).toHaveLength(2);
        expect(container.querySelector('[data-streamdown="inline-code-chip"]')).toBeNull();

        await answer();
        await draw();

        expect(container.querySelector('[data-streamdown="inline-code-chip"]')?.textContent).toBe('CAR-39');
        expect(container.querySelectorAll('[data-streamdown="inline-code"]')).toHaveLength(1);
        expect(asked).toEqual(['CAR-39']);
    });

    it('is asked for again when a snapshot is taken in after the daemon could not be read, and the chip comes then', async () => {
        offline = true;
        await drawBubble('Take CAR-38');
        await answer();

        expect(chips()).toEqual([]);
        expect(asked).toEqual(['CAR-38']);

        // Drawn again, it does not ask again: the daemon would only be asked in vain.
        await drawBubble('Take CAR-38');
        await answer();
        expect(asked).toEqual(['CAR-38']);

        offline = false;
        await act(async () => {
            store.selectedProject!.applySnapshot(await daemon.getProjectSnapshot('p-car'));
        });
        await answer();

        expect(chips()).toEqual(['CAR-38']);
        expect(asked).toEqual(['CAR-38', 'CAR-38']);
    });
});
