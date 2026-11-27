// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Button } from '../Button';
import { RowControls } from '../List';
import { Badge } from '../Tag';
import { Chip } from './Chip';

import type { ReactNode } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const render = (node: ReactNode) => act(() => root.render(node));

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('Chip', () => {
    it('is a plain span with no role or tab stop when it only labels', () => {
        render(<Chip tone="success">Done</Chip>);

        const chip = container.firstElementChild!;

        expect([chip.tagName, chip.getAttribute('role'), chip.getAttribute('tabindex')]).toEqual(['SPAN', null, null]);
    });

    it('is a button when it has an action', () => {
        render(<Chip onPress={() => undefined}>CLO-12</Chip>);

        expect(container.querySelector('button')?.textContent).toBe('CLO-12');
    });

    it('is focusable and named by its label when it carries a tip', () => {
        render(<Chip tooltip="Merged into main">Merged</Chip>);

        const chip = container.querySelector('span')!;

        expect([chip.getAttribute('role'), chip.getAttribute('aria-label'), chip.tabIndex]).toEqual([
            'img',
            'Merged',
            0,
        ]);
    });
});

describe('Badge', () => {
    it('renders a span, not a one-tag grid', () => {
        render(<Badge size="xs">Main</Badge>);

        expect([container.querySelector('[role="grid"]'), container.firstElementChild?.tagName]).toEqual([
            null,
            'SPAN',
        ]);
    });
});

describe('Button disabledReason', () => {
    it('puts a disabled button in a focusable stand-in named by its label', () => {
        render(
            <Button isDisabled disabledReason="Commit the changes first">
                Merge
            </Button>
        );

        const standIn = container.querySelector('[role="button"][aria-disabled="true"]') as HTMLElement;

        expect([
            standIn.tabIndex,
            standIn.getAttribute('aria-label'),
            standIn.querySelector('button')?.disabled,
        ]).toEqual([0, 'Merge', true]);
    });

    it('renders the button alone while it is enabled', () => {
        render(<Button disabledReason="Commit the changes first">Merge</Button>);

        expect(container.querySelector('[aria-disabled]')).toBeNull();
    });
});

describe('RowControls', () => {
    it('keeps a click on its buttons from reaching the row', () => {
        const reached: string[] = [];

        render(
            <div onClick={() => reached.push('row')}>
                <RowControls>
                    <button type="button">Archive</button>
                </RowControls>
            </div>
        );

        act(() => container.querySelector('button')!.click());

        expect(reached).toEqual([]);
    });
});
