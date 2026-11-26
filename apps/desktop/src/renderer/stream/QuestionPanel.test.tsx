// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuestionPanel } from './QuestionPanel';

import type { StreamItemBody } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Question = Extract<StreamItemBody, { kind: 'question' }>;

let container: HTMLDivElement;
let root: Root;
/** What the clamps measure: the height of the text, and the height it is allowed. */
let layout = { scrollHeight: 0, clientHeight: 0 };

beforeEach(() => {
    layout = { scrollHeight: 0, clientHeight: 0 };
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe = () => undefined;
            disconnect = () => undefined;
            unobserve = () => undefined;
        }
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get: () => layout.scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get: () => layout.clientHeight,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
});

const question = (fields: Partial<Question> = {}): Question => ({
    kind: 'question',
    questionId: 'q1',
    text: 'Who can export orders?\n\nThe orders page is visible to every signed-in user.\n\nMy pick: Admins only.',
    options: [
        { id: 'admins', label: 'Admins only', consequence: 'Nobody gains access to personal data' },
        { id: 'everyone', label: 'Everyone who sees orders' },
    ],
    recommended: 'admins',
    ...fields,
});
const draw = (fields?: Partial<Question>, onAnswer?: (answer: string) => void | Promise<void>) =>
    act(async () => root.render(<QuestionPanel question={question(fields)} onAnswer={onAnswer} />));
const rows = () => [...container.querySelectorAll<HTMLElement>('[role="row"]')];
const row = (label: string) => rows().find(candidate => candidate.textContent?.includes(label));
const send = () => container.querySelector<HTMLButtonElement>('button[aria-label="Next"]');
const skip = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Skip');
const field = () => container.querySelector<HTMLTextAreaElement>('textarea')!;
const typeInField = async (text: string) => {
    await act(async () => field().focus());
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field(), text);
        field().dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const press = (key: string, init: KeyboardEventInit = {}) =>
    act(async () => {
        field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    });

describe('QuestionPanel', () => {
    it('lists the options as numbered rows with their consequence and the recommended one preselected', async () => {
        await draw(undefined, vi.fn());

        expect(container.querySelector('form')?.textContent).toContain('Who can export orders?');
        expect(rows().map(candidate => candidate.textContent)).toEqual([
            expect.stringMatching(/^1Admins onlyRecommendedNobody gains access to personal data$/),
            '2Everyone who sees orders',
            '',
        ]);
        expect(row('Admins only')?.getAttribute('aria-selected')).toBe('true');
        expect(row('Everyone')?.getAttribute('aria-selected')).toBe('false');
    });

    it('sends the label of the preselected option', async () => {
        const onAnswer = vi.fn();

        await draw(undefined, onAnswer);
        await act(async () => send()!.click());

        expect(onAnswer).toHaveBeenCalledWith('Admins only');
    });

    it('sends the label of the option the person picked', async () => {
        const onAnswer = vi.fn();

        await draw(undefined, onAnswer);
        await act(async () => row('Everyone')!.click());

        expect(row('Everyone')?.getAttribute('aria-selected')).toBe('true');

        await act(async () => send()!.click());

        expect(onAnswer).toHaveBeenCalledWith('Everyone who sees orders');
    });

    it('takes the person own words once they start typing, and sends them trimmed', async () => {
        const onAnswer = vi.fn();

        await draw(undefined, onAnswer);
        await typeInField('  Only the owner  ');

        expect(row('Admins only')?.getAttribute('aria-selected')).toBe('false');

        await act(async () => send()!.click());

        expect(onAnswer).toHaveBeenCalledWith('Only the owner');
    });

    it('offers no send while the field is picked and empty', async () => {
        await draw(undefined, vi.fn());
        await act(async () => field().focus());

        expect(send()?.disabled).toBe(true);

        await typeInField('Something');

        expect(send()?.disabled).toBe(false);
    });

    it('sends on Enter in the field, and starts a new line on Shift+Enter', async () => {
        const onAnswer = vi.fn();

        await draw(undefined, onAnswer);
        await typeInField('Only the owner');
        await press('Enter', { shiftKey: true });

        expect(onAnswer).not.toHaveBeenCalled();

        await press('Enter');

        expect(onAnswer).toHaveBeenCalledOnce();
        expect(onAnswer).toHaveBeenCalledWith('Only the owner');
    });

    it('is only the field when the question has no options', async () => {
        const onAnswer = vi.fn();

        await draw({ options: [], recommended: undefined }, onAnswer);

        expect(rows()).toHaveLength(1);
        expect(send()?.disabled).toBe(true);

        await typeInField('Our own plan');
        await act(async () => send()!.click());

        expect(onAnswer).toHaveBeenCalledWith('Our own plan');
    });

    it('is read-only without a way to answer', async () => {
        await draw();

        expect(send()?.disabled).toBe(true);
        expect(skip()?.disabled).toBe(true);
    });

    it('gives the agent Skipped when the person skips', async () => {
        const onAnswer = vi.fn();

        await draw(undefined, onAnswer);
        await typeInField('Not sent');
        await act(async () => skip()!.click());

        expect(onAnswer).toHaveBeenCalledOnce();
        expect(onAnswer).toHaveBeenCalledWith('Skipped');
    });

    it('takes no second answer while one is on its way', async () => {
        const onAnswer = vi.fn(() => new Promise<void>(() => undefined));

        await draw(undefined, onAnswer);
        await act(async () => send()!.click());
        await act(async () => skip()!.click());

        expect(onAnswer).toHaveBeenCalledOnce();
        expect(skip()?.disabled).toBe(true);
    });

    describe('a long question', () => {
        const toggle = () =>
            [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Show'));
        const withText = (text: string) =>
            [...container.querySelectorAll('div')].filter(div => div.children.length === 0 && div.textContent === text);

        it('has no toggle when the title and the facts fit', async () => {
            await draw(undefined, vi.fn());

            expect(toggle()).toBeUndefined();
        });

        it('opens the title and the facts together from one toggle, and shuts them again', async () => {
            layout = { scrollHeight: 200, clientHeight: 40 };
            await draw(undefined, vi.fn());

            expect(toggle()?.textContent).toBe('Show more');
            expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
            // Shut, the facts run on from line to line in one block, so the lines are counted as they are drawn.
            expect(withText('The orders page is visible to every signed-in user.\nMy pick: Admins only.')).toHaveLength(
                1
            );
            expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(1);

            await act(async () => toggle()!.click());

            expect(toggle()?.textContent).toBe('Show less');
            expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
            expect(withText('The orders page is visible to every signed-in user.')).toHaveLength(1);
            expect(withText('My pick: Admins only.')).toHaveLength(1);

            await act(async () => toggle()!.click());

            expect(toggle()?.textContent).toBe('Show more');
        });

        it('offers the toggle for a long title when there are no facts', async () => {
            layout = { scrollHeight: 120, clientHeight: 40 };
            await draw({ text: 'A question that runs on and on?' }, vi.fn());

            expect(toggle()?.textContent).toBe('Show more');
        });
    });
});
