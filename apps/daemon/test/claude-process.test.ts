import { afterEach, describe, expect, test } from 'bun:test';

import { killProcessGroup, spawnInOwnGroup } from '../src/engine/claude/process';
import { sleep, until } from './claude-fakes';

import type { ChildProcess } from 'node:child_process';

const posix = test.skipIf(process.platform === 'win32');

const alive = (pgid: number) => {
    try {
        process.kill(-pgid, 0);

        return true;
    }
    catch {
        return false;
    }
};

const groupOf = (pid: number) => Number(Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)]).stdout.toString().trim());

const spawned: number[] = [];

afterEach(() => {
    for (const pid of spawned.splice(0)) {
        killProcessGroup(pid, 'SIGKILL');
    }
});

function start(script: string, signal = new AbortController().signal) {
    const stderr: string[] = [];
    const spawn = spawnInOwnGroup({ onSpawn: pid => spawned.push(pid), onStderr: text => stderr.push(text) });
    const child = spawn({ command: 'sh', args: ['-c', script], env: { PATH: process.env.PATH }, signal }) as ChildProcess;

    return { child, stderr };
}

describe('the claude process group', () => {
    posix('the process leads its own group, apart from the daemon\'s', () => {
        const { child } = start('sleep 30');

        expect(groupOf(child.pid!)).toBe(child.pid!);
        expect(groupOf(child.pid!)).not.toBe(groupOf(process.pid));
    });

    posix('stopping the process stops what it started too', async () => {
        const { child } = start('sleep 30 & sleep 30 & wait');

        await sleep(100);
        expect(alive(child.pid!)).toBe(true);

        child.kill('SIGTERM');
        await until(() => !alive(child.pid!));
    });

    posix('aborting the signal stops the group', async () => {
        const controller = new AbortController();
        const { child } = start('sleep 30 & wait', controller.signal);

        await sleep(100);
        controller.abort();
        await until(() => !alive(child.pid!));
    });

    posix('a group that ignores the polite stop is killed after the grace period', async () => {
        const controller = new AbortController();
        const { child } = start('trap "" TERM; while true; do sleep 1; done', controller.signal);

        await sleep(100);
        controller.abort();
        await sleep(300);
        expect(alive(child.pid!)).toBe(true);
        await until(() => !alive(child.pid!), 4000);
    });

    posix('what the process left running after it exited goes with it', async () => {
        const { child } = start('sleep 30 & echo leader-done');

        await until(() => child.exitCode !== null);
        await until(() => !alive(child.pid!));
    });

    posix('stderr is read, so a chatty process never blocks on a full pipe', async () => {
        const { child, stderr } = start('yes oops | head -c 300000 1>&2');

        await until(() => child.exitCode !== null);
        expect(stderr.join('').length).toBe(300000);
    });
});
