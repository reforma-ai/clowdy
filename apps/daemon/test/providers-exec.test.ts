import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEFTOVER_GRACE_MS, runProgram } from '../src/providers/exec';
import { cleanTempDirs, tempDir, waitFor } from './helpers';

import type { RunOptions } from '../src/providers/exec';

afterAll(cleanTempDirs);

/** The programs are POSIX shell scripts, and Windows has no process groups to leave something in. */
const onPosix = process.platform === 'win32' ? describe.skip : describe;

/** A program whose body is a shell script, which gets the folder it may write in as `$1`. */
function program(body: string): { path: string; dir: string } {
    const dir = tempDir('exec');
    const path = join(dir, 'program.sh');

    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);

    return { path, dir };
}

const run = ({ path, dir }: { path: string; dir: string }, options: Partial<RunOptions> = {}) =>
    runProgram(path, [dir], { env: { PATH: process.env.PATH ?? '' }, cwd: dir, timeoutMs: 20_000, ...options });

/** Whether the process is there; one that was killed and is waiting to be reaped is not. */
function alive(pid: number): boolean {
    const state = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)])
        .stdout.toString()
        .trim();

    return state !== '' && !state.startsWith('Z');
}

const pidIn = (dir: string) => Number(readFileSync(join(dir, 'leftover.pid'), 'utf8'));

onPosix('runProgram, what a program leaves in its group', () => {
    test('lets a child that leaves the group by itself finish, so a lock it holds is released by it, not left behind', async () => {
        // git's detached maintenance holds objects/maintenance.lock while it leaves the group, and the program that started it is gone by then.
        const fake = program(
            '( : > "$1/the.lock"; sleep 0.2; rm -f "$1/the.lock" ) > /dev/null 2>&1 &\nwhile [ ! -e "$1/the.lock" ]; do :; done'
        );
        const lock = join(fake.dir, 'the.lock');

        expect(existsSync(lock)).toBe(false);
        expect((await run(fake, { leftoverGraceMs: LEFTOVER_GRACE_MS })).code).toBe(0);
        await waitFor(() => !existsSync(lock), 'the child to release its lock', 5000);
    });

    test('answers when the pipes close, not when the grace ends, when nothing is left', async () => {
        const fake = program('echo done');
        const started = Date.now();
        const result = await run(fake, { leftoverGraceMs: 5000 });

        expect(result).toMatchObject({ code: 0, stdout: 'done\n', timedOut: false });
        expect(Date.now() - started).toBeLessThan(2500);
    });

    test("answers at the end of the grace, with the program's own code, when a leftover holds the pipes, and kills it then", async () => {
        const fake = program('sleep 30 &\necho $! > "$1/leftover.pid"\necho started\nexit 3');
        const started = Date.now();
        const result = await run(fake, { leftoverGraceMs: 500 });
        const waited = Date.now() - started;

        expect(result).toMatchObject({ code: 3, stdout: 'started\n', timedOut: false });
        // Not before the grace is over, and not hung for the 30 s the leftover would take.
        expect(waited).toBeGreaterThanOrEqual(450);
        expect(waited).toBeLessThan(10_000);
        await waitFor(() => !alive(pidIn(fake.dir)), 'the leftover to be killed', 5000);
    });

    test('spares a leftover that holds nothing open until the grace is over, and kills it then', async () => {
        const fake = program('sleep 30 > /dev/null 2>&1 &\necho $! > "$1/leftover.pid"');

        await run(fake, { leftoverGraceMs: 800 });

        const pid = pidIn(fake.dir);

        expect(alive(pid)).toBe(true);
        await waitFor(() => !alive(pid), 'the leftover to be killed', 5000);
    });

    test('does not spare what a stopped program left: the daemon stopping kills it as before, grace or not', async () => {
        // The program goes on a TERM, as git does, and its leftover ignores it.
        const fake = program(
            "trap 'exit 0' TERM\n( trap '' TERM; exec sleep 30 ) > /dev/null 2>&1 &\necho $! > \"$1/leftover.pid\"\nwhile :; do sleep 0.05; done"
        );
        const stopper = new AbortController();
        const running = run(fake, { signal: stopper.signal, stopSignal: 'SIGTERM', leftoverGraceMs: 8000 });

        // A script that was just written can take a while to start the first time it runs.
        await waitFor(
            () => existsSync(join(fake.dir, 'leftover.pid')) && pidIn(fake.dir),
            'the program to start',
            10_000
        );
        stopper.abort();

        expect((await running).error).toBe('stopped');
        // Far inside the 8 s of the grace, and inside the 2 s the stop itself allows.
        await waitFor(() => !alive(pidIn(fake.dir)), 'the leftover to be killed', 1500);
    });

    test('kills a leftover at once when no grace is asked for, as every other caller gets', async () => {
        const fake = program('sleep 30 > /dev/null 2>&1 &\necho $! > "$1/leftover.pid"');

        await run(fake);
        await waitFor(() => !alive(pidIn(fake.dir)), 'the leftover to be killed', 5000);
    });
});
