import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEFTOVER_GRACE_MS, runProgram } from '../src/process/run';
import { cleanTempDirs, tempDir, waitFor } from './helpers';

import type { RunOptions } from '../src/process/run';

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

onPosix('runProgram, a program that is watched and waited for', () => {
    test('hands over what the program prints on its error stream as it prints it, and a callback that throws changes nothing', async () => {
        const fake = program('printf "one\\r" >&2; sleep 0.2; printf "two\\n" >&2');
        const pieces: string[] = [];
        const result = await run(fake, {
            onStderr: text => {
                pieces.push(text);

                throw new Error('the reader failed');
            },
        });

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('one\rtwo\n');
        expect(pieces.length).toBeGreaterThanOrEqual(2);
        expect(pieces.join('')).toBe('one\rtwo\n');
    });

    test('answers at the stop by default, and only once the program is gone with `untilGone`', async () => {
        // The program takes the polite stop slowly and writes a file as it goes: a caller that cleans up must find it written.
        const body =
            'trap \'sleep 0.5; : > "$1/after-stop"; exit 0\' TERM\n: > "$1/started"\nwhile :; do sleep 0.05; done';

        for (const untilGone of [false, true]) {
            const fake = program(body);
            const controller = new AbortController();
            const running = run(fake, { signal: controller.signal, stopSignal: 'SIGTERM', untilGone });

            // A script that was just written can take a while to start the first time it runs, and it handles the stop only once it has.
            await waitFor(() => existsSync(join(fake.dir, 'started')), 'the program to start', 10_000);
            controller.abort();

            const result = await running;

            expect(result.error).toBe('stopped');
            expect(existsSync(join(fake.dir, 'after-stop'))).toBe(untilGone);
            await waitFor(() => existsSync(join(fake.dir, 'after-stop')), 'the program to finish its stop', 5000);
        }
    });

    test('says the deadline in the result with `untilGone`, after the program is gone', async () => {
        const fake = program(
            'trap \'sleep 0.3; : > "$1/after-stop"; exit 0\' TERM\n: > "$1/started"\nwhile :; do sleep 0.05; done'
        );
        const running = run(fake, { timeoutMs: 3000, stopSignal: 'SIGTERM', untilGone: true });

        await waitFor(() => existsSync(join(fake.dir, 'started')), 'the program to start', 10_000);

        const result = await running;

        expect(result.timedOut).toBe(true);
        expect(existsSync(join(fake.dir, 'after-stop'))).toBe(true);
    });

    test('does not wait on a descendant that left the group and holds the pipes, past the grace after the program exited', async () => {
        const perl = Bun.which('perl');

        if (!perl) return;

        // The descendant starts a session of its own, so the group kill does not reach it, and it keeps the error stream open for eight seconds.
        const fake = program(
            `'${perl}' -MPOSIX -e 'POSIX::setsid(); sleep 8' &\n: > "$1/started"\nwhile :; do sleep 0.05; done`
        );
        const controller = new AbortController();
        const running = run(fake, { signal: controller.signal, stopSignal: 'SIGTERM', untilGone: true });

        await waitFor(() => existsSync(join(fake.dir, 'started')), 'the program to start', 10_000);
        await Bun.sleep(300);

        const stopped = Date.now();

        controller.abort();

        const result = await running;

        expect(result.error).toBe('stopped');
        expect(Date.now() - stopped).toBeLessThan(5000);
    });
});
