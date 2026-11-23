// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_STATUSES } from '../../daemon/fixtureData';
import { DependencyList } from './DependencyList';

import type { Task } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function task(number: number, statusId: string): Task {
    return {
        id: `t-${number}`,
        projectId: 'p',
        number,
        key: `CAR-${number}`,
        title: `Task ${number}`,
        description: '',
        statusId,
        dependsOn: [],
        createdBy: { kind: 'user' },
        createdAt: 0,
        updatedAt: 0,
    };
}

const TASKS = [
    task(1, 'done'),
    task(2, 'canceled'),
    task(3, 'active'),
    task(4, 'todo'),
    task(5, 'review'),
    task(6, 'gone'),
];

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

/** The ticks of the list, in order: the text a screen reader says and whether the box is ticked. */
async function ticks(ids: string[], statuses = DEFAULT_STATUSES) {
    await act(async () => {
        root.render(
            <DependencyList
                ids={ids}
                tasks={new Map(TASKS.map(item => [item.id, item]))}
                statuses={statuses}
                candidates={[]}
                onAdd={() => undefined}
                onRemove={() => undefined}
            />
        );
    });

    return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(box => [
        box.getAttribute('aria-label'),
        box.checked,
    ]);
}

describe('DependencyList', () => {
    it('ticks a dependency that is done, and says Done', async () => {
        expect(await ticks(['t-1'])).toEqual([['Done', true]]);
    });

    it('ticks a dependency that is canceled too, since a closed task releases the task that waits for it, and says Canceled', async () => {
        expect(await ticks(['t-2'])).toEqual([['Canceled', true]]);
    });

    it('leaves a dependency that is still open unticked: to do, in progress and in review alike', async () => {
        expect(await ticks(['t-3', 't-4', 't-5'])).toEqual([
            ['Not done', false],
            ['Not done', false],
            ['Not done', false],
        ]);
    });

    it('treats a dependency whose status the workflow lost as not done', async () => {
        expect(await ticks(['t-6'])).toEqual([['Not done', false]]);
    });

    it('follows the category of the status, whatever the status is called', async () => {
        const statuses = [
            { id: 'done', name: 'Shipped', category: 'canceled' as const },
            { id: 'canceled', name: 'Finished', category: 'done' as const },
            { id: 'active', name: 'Active', category: 'active' as const },
        ];

        expect(await ticks(['t-1', 't-2', 't-3'], statuses)).toEqual([
            ['Canceled', true],
            ['Done', true],
            ['Not done', false],
        ]);
    });

    it('shows a dependency the project does not hold as a removed task, not ticked', async () => {
        expect(await ticks(['t-404'])).toEqual([['Not done', false]]);
        expect(container.textContent).toContain('Removed task');
    });
});
