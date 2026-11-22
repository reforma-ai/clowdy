// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from './ApprovalCard';

import type { ApprovalDecision, StreamItemBody } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Approval = Extract<StreamItemBody, { kind: 'approval' }>;

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

const approval = (fields: Partial<Approval> = {}): Approval => ({
    kind: 'approval',
    approvalId: 'apv-1',
    title: 'ls -la',
    subject: { kind: 'command', command: 'ls -la' },
    decisions: ['allow_once', 'allow_always', 'reject'],
    state: 'open',
    ...fields,
});
const draw = (fields?: Partial<Approval>, onDecide?: (decision: ApprovalDecision) => void | Promise<void>) => act(async () => root.render(<ApprovalCard approval={ approval(fields) } onDecide={ onDecide } />));
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('button')];
const button = (label: string) => buttons().find(candidate => candidate.textContent === label);
const labels = () => buttons().map(candidate => candidate.textContent);
const code = () => container.querySelector('pre')?.textContent;

describe('ApprovalCard', () => {
    describe('what is asked', () => {
        it('shows a command as a shell does, with the folder it runs in', async () => {
            await draw({ subject: { kind: 'command', command: 'bun run test', cwd: '/work/car-rental' } }, vi.fn());

            expect(container.textContent).toContain('Run this command');
            expect(code()).toBe('$ bun run test');
            expect(container.textContent).toContain('/work/car-rental');
        });

        it('cuts a long command at four lines until the rest is asked for, and cuts it again', async () => {
            const command = ['one', 'two', 'three', 'four', 'five', 'six'].join('\n');

            await draw({ subject: { kind: 'command', command } }, vi.fn());

            expect(code()).toBe('$ one\ntwo\nthree\nfour');
            expect(button('Show 2 more lines')?.getAttribute('aria-expanded')).toBe('false');

            await act(async () => button('Show 2 more lines')!.click());

            expect(code()).toBe(`$ ${ command }`);
            expect(button('Show less')?.getAttribute('aria-expanded')).toBe('true');

            await act(async () => button('Show less')!.click());

            expect(code()).toBe('$ one\ntwo\nthree\nfour');
        });

        it('says "1 more line" for the one that is left, and has no toggle for a command that fits', async () => {
            await draw({ subject: { kind: 'command', command: 'a\nb\nc\nd\ne' } }, vi.fn());

            expect(button('Show 1 more line')).toBeDefined();

            await draw({ subject: { kind: 'command', command: 'a\nb\nc\nd' } }, vi.fn());

            expect(buttons().some(candidate => candidate.textContent?.startsWith('Show'))).toBe(false);
        });

        it('lists the files a change touches, one to a line', async () => {
            await draw({ subject: { kind: 'file_change', paths: ['src/booking/price.ts', 'src/booking/steps.tsx'] } }, vi.fn());

            expect(container.textContent).toContain('Change these files');
            expect([...container.querySelectorAll('li')].map(row => row.textContent)).toEqual(['src/booking/price.ts', 'src/booking/steps.tsx']);

            await draw({ subject: { kind: 'file_change', paths: ['src/booking/price.ts'] } }, vi.fn());

            expect(container.textContent).toContain('Change this file');
        });

        it('names a tool and says what it does, from its detail or else from what the agent calls the request', async () => {
            await draw({ title: 'Publish', subject: { kind: 'tool_use', tool: 'mcp__docs__publish', detail: 'Publish "Rules" to the docs' } }, vi.fn());

            expect(container.textContent).toContain('Use mcp__docs__publish');
            expect(container.textContent).toContain('Publish "Rules" to the docs');
            expect(container.textContent).not.toContain('Publish.');

            await draw({ title: 'Create a page in the docs', subject: { kind: 'tool_use', tool: 'mcp__docs__create' } }, vi.fn());

            expect(container.textContent).toContain('Create a page in the docs');

            // A title that only repeats the tool's name adds nothing.
            await draw({ title: 'mcp__docs__create', subject: { kind: 'tool_use', tool: 'mcp__docs__create' } }, vi.fn());

            expect(container.textContent?.match(/mcp__docs__create/g)).toHaveLength(1);
        });
    });

    describe('while it waits', () => {
        it('has a button for each answer the agent allows, Deny first and Allow once last', async () => {
            await draw({}, vi.fn());

            expect(labels().filter(label => ['Deny', 'Allow for session', 'Allow once'].includes(label ?? ''))).toEqual(['Deny', 'Allow for session', 'Allow once']);

            await draw({ decisions: ['allow_once', 'reject'] }, vi.fn());

            expect(labels()).toEqual(['Deny', 'Allow once']);

            await draw({ decisions: ['reject'] }, vi.fn());

            expect(labels()).toEqual(['Deny']);
        });

        it('sends the answer a button stands for', async () => {
            const onDecide = vi.fn();

            await draw({}, onDecide);
            await act(async () => button('Allow once')!.click());
            await act(async () => button('Allow for session')!.click());
            await act(async () => button('Deny')!.click());

            expect(onDecide.mock.calls).toEqual([['allow_once'], ['allow_always'], ['reject']]);
        });

        it('spins the button that was pressed and holds the others until the answer is taken, then lets the person try again', async () => {
            let finish: () => void = () => undefined;
            const onDecide = vi.fn(() => new Promise<void>((resolve) => {
                finish = resolve;
            }));

            await draw({}, onDecide);
            await act(async () => button('Allow once')!.click());

            expect(button('Allow once')!.hasAttribute('data-pending')).toBe(true);
            expect(button('Deny')!.disabled).toBe(true);
            expect(button('Allow for session')!.disabled).toBe(true);

            // A second press while one is on its way sends nothing.
            await act(async () => button('Deny')!.click());

            expect(onDecide).toHaveBeenCalledTimes(1);

            await act(async () => finish());

            expect(button('Allow once')!.hasAttribute('data-pending')).toBe(false);
            expect(button('Deny')!.disabled).toBe(false);
        });

        it('is only to be read when nobody can answer it', async () => {
            await draw({});

            expect(buttons()).toHaveLength(0);
            expect(container.textContent).toContain('Waiting for an answer');
            expect(code()).toBe('$ ls -la');
        });
    });

    describe('once it is not open', () => {
        const settled = async (fields: Partial<Approval>) => {
            const onDecide = vi.fn();

            // `onDecide` is given on purpose: the item's own state decides, not the caller.
            await draw(fields, onDecide);

            return onDecide;
        };

        it('says what was decided, keeps what was asked and has no buttons', async () => {
            await settled({ state: 'decided', decision: 'allow_once' });

            expect(container.textContent).toContain('Allowed once');
            expect(code()).toBe('$ ls -la');
            expect(buttons()).toHaveLength(0);

            await settled({ state: 'decided', decision: 'allow_always' });

            expect(container.textContent).toContain('Allowed for the session');

            await settled({ state: 'decided', decision: 'reject' });

            expect(container.textContent).toContain('Denied');
            expect(buttons()).toHaveLength(0);
        });

        it('says when the agent took the request back or the daemon restarted', async () => {
            await settled({ state: 'cancelled' });

            expect(container.textContent).toContain('Cancelled');
            expect(buttons()).toHaveLength(0);

            await settled({ state: 'expired' });

            expect(container.textContent).toContain('Expired');
            expect(buttons()).toHaveLength(0);
            expect(code()).toBe('$ ls -la');
        });
    });
});
