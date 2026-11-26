// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuestionCard } from './QuestionCard';

import type { StreamItemBody } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Question = Extract<StreamItemBody, { kind: 'question' }>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const question = (fields: Partial<Question> = {}): Question => ({
    kind: 'question',
    questionId: 'q1',
    text: 'Who can export orders?\n\nThe orders page is visible to every signed-in user.\n\nMy pick: Admins only.',
    options: [
        { id: 'admins', label: 'Admins only' },
        { id: 'everyone', label: 'Everyone who sees orders' },
    ],
    recommended: 'admins',
    ...fields,
});
const draw = (fields?: Partial<Question>, props: { docked?: boolean; onAnswer?: () => void } = {}) =>
    act(async () => root.render(<QuestionCard question={question(fields)} {...props} />));

describe('QuestionCard', () => {
    it('frames the form of a question that waits for an answer', async () => {
        await draw(undefined, { onAnswer: vi.fn() });

        expect(container.querySelector('form')).not.toBeNull();
        expect(container.textContent).toContain('The orders page is visible to every signed-in user.');
    });

    it('is a line saying where to answer while the box under the chat holds the form', async () => {
        await draw(undefined, { docked: true });

        expect(container.querySelector('form')).toBeNull();
        expect(container.textContent).toBe('Answer in the box below');
    });

    it('shows the question and its answer once answered, without the facts, docked or not', async () => {
        await draw({ answer: 'Admins only' }, { docked: true });

        expect(container.querySelector('form')).toBeNull();
        expect(container.textContent).toContain('Answer');
        expect(container.textContent).toContain('Who can export orders?');
        expect(container.textContent).toContain('Admins only');
        expect(container.textContent).not.toContain('The orders page is visible');
        expect(container.textContent).not.toContain('My pick');
        expect(container.textContent).not.toContain('Answer in the box below');
    });

    it('keeps the lines of an answer the person wrote', async () => {
        await draw({ answer: 'First line\nSecond line' });

        const line = [...container.querySelectorAll('span')].find(
            span => span.textContent === 'First line\nSecond line'
        );

        expect(line?.className).toContain('whitespace-pre-line');
    });

    it.each([
        ['preparing', 'Stopping the agent…'],
        ['expired', 'Question expired'],
        ['cancelled', 'Question withdrawn'],
    ] as const)('says a %s question is not waiting any more', async (state, line) => {
        await draw({ state }, { docked: true });

        expect(container.querySelector('form')).toBeNull();
        expect(container.textContent).toContain('Who can export orders?');
        expect(container.textContent).toContain(line);
    });
});
