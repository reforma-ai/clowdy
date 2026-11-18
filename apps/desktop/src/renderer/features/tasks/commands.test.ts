import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendCommand, sendEach, startTask } from './commands';

import type { CommandResult } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { RootStore } from '../../stores';

const toasts = vi.hoisted(() => ({ error: vi.fn<(options: { message: string }) => void>() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

const accepted: CommandResult = { ok: true, requestId: 'r', data: {} };
const refused = (message: string): CommandResult => ({ ok: false, requestId: 'r', error: { code: 'invalid', message } });

const update = (taskId: string): CommandInput => ({ type: 'task.update', taskId, statusId: 'done' });

/** A store whose daemon answers each command with the next result of the list, and remembers what it was asked. */
function store(...results: CommandResult[]) {
    const asked: CommandInput[] = [];
    const queue = [...results];
    const command = vi.fn(async (input: CommandInput) => {
        asked.push(input);

        return queue.shift() ?? accepted;
    });

    return { root: { command } as unknown as RootStore, asked, command };
}

beforeEach(() => {
    toasts.error.mockClear();
});

describe('sendCommand', () => {
    it('shows a refusal and returns it', async () => {
        const { root } = store(refused('No such task'));
        const result = await sendCommand(root, update('t-1'));

        expect(result.ok).toBe(false);
        expect(toasts.error).toHaveBeenCalledWith({ message: 'No such task' });
    });
});

describe('sendEach', () => {
    it('sends one command per input, one after the other and in order, and returns the results in that order', async () => {
        const order: string[] = [];
        const command = vi.fn(async (input: CommandInput) => {
            order.push(`start ${ 'taskId' in input ? input.taskId : '' }`);
            await Promise.resolve();
            order.push(`end ${ 'taskId' in input ? input.taskId : '' }`);

            return 'taskId' in input && input.taskId === 't-2' ? refused('No') : accepted;
        });
        const results = await sendEach({ command } as unknown as RootStore, [update('t-1'), update('t-2'), update('t-3')]);

        expect(order).toEqual(['start t-1', 'end t-1', 'start t-2', 'end t-2', 'start t-3', 'end t-3']);
        expect(results.map(result => result.ok)).toEqual([true, false, true]);
    });

    it('says nothing when every command is accepted', async () => {
        const { root } = store();

        await sendEach(root, [update('t-1'), update('t-2')]);

        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('shows the daemon\'s message for the only command when it is refused', async () => {
        const { root } = store(refused('No such task'));

        await sendEach(root, [update('t-1')]);

        expect(toasts.error).toHaveBeenCalledTimes(1);
        expect(toasts.error).toHaveBeenCalledWith({ message: 'No such task' });
    });

    it('shows one toast for any number of refusals, with how many failed and the first message, and keeps going after one', async () => {
        const { root, asked } = store(accepted, refused('First reason'), refused('Second reason'), accepted, refused('Third reason'));
        const results = await sendEach(root, ['t-1', 't-2', 't-3', 't-4', 't-5'].map(update));

        expect(asked).toHaveLength(5);
        expect(results.filter(result => !result.ok)).toHaveLength(3);
        expect(toasts.error).toHaveBeenCalledTimes(1);
        expect(toasts.error).toHaveBeenCalledWith({ message: '3 of 5 changes failed: First reason' });
    });

    it('does nothing for nothing', async () => {
        const { root, command } = store();

        expect(await sendEach(root, [])).toEqual([]);
        expect(command).not.toHaveBeenCalled();
        expect(toasts.error).not.toHaveBeenCalled();
    });
});

describe('startTask', () => {
    it('sends task.start and says whether the daemon took it', async () => {
        const { root, asked } = store(accepted, refused('CAR-1 already has an active run'));

        expect(await startTask(root, 't-1')).toBe(true);
        expect(await startTask(root, 't-1')).toBe(false);
        expect(asked).toEqual([{ type: 'task.start', taskId: 't-1' }, { type: 'task.start', taskId: 't-1' }]);
        expect(toasts.error).toHaveBeenCalledTimes(1);
    });

    it('does not start a task twice while its first start is on the way', async () => {
        let answer: (result: CommandResult) => void = () => undefined;
        const command = vi.fn(() => new Promise<CommandResult>((resolve) => {
            answer = resolve;
        }));
        const root = { command } as unknown as RootStore;
        const first = startTask(root, 't-9');

        expect(await startTask(root, 't-9')).toBe(false);
        expect(command).toHaveBeenCalledTimes(1);

        answer(accepted);

        expect(await first).toBe(true);

        // Once it is answered the task can be started again.
        const again = startTask(root, 't-9');

        answer(accepted);

        expect(await again).toBe(true);
        expect(command).toHaveBeenCalledTimes(2);
    });

    it('lets different tasks start side by side', async () => {
        const { root, asked } = store();

        await Promise.all([startTask(root, 't-1'), startTask(root, 't-2')]);

        expect(asked.map(input => 'taskId' in input && input.taskId)).toEqual(['t-1', 't-2']);
    });
});
