import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAppServer } from '../src/providers/appserver';
import { claudeAccount, claudeWindows, parseClaudeStatus, parseClaudeUsage } from '../src/providers/claude/account';
import { codexAccount, codexPlan, codexWindows, parseCodexAccount, windowLabel } from '../src/providers/codex/account';
import {
    cursorAccount,
    cursorConfigDirs,
    cursorWindows,
    readCursorIdentity,
    readCursorToken,
} from '../src/providers/cursor/account';
import { runProgram } from '../src/providers/exec';
import { planLabel } from '../src/providers/parse';

import type { ProbeContext } from '../src/providers/types';

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clowdy-providers-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** An executable written to the temp folder. `body` is the script after its first line. */
function program(name: string, body: string, shebang = '#!/bin/sh'): string {
    const path = join(root, name);

    writeFileSync(path, `${shebang}\n${body}\n`);
    chmodSync(path, 0o755);

    return path;
}

function context(overrides: Partial<ProbeContext> = {}): ProbeContext {
    return {
        program: '/bin/false',
        env: { PATH: process.env.PATH ?? '' },
        cwd: root,
        fetch: (async () => new Response('{}')) as unknown as typeof fetch,
        now: () => 1_000,
        platform: 'linux',
        home: join(root, 'home'),
        ...overrides,
    };
}

describe('runProgram', () => {
    test('answers with what the program printed and how it ended, without throwing', async () => {
        const ok = await runProgram(program('ok', 'echo out; echo err >&2; exit 3'), [], {
            env: {},
            cwd: root,
            timeoutMs: 5000,
        });

        expect(ok).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });

        const missing = await runProgram(join(root, 'nothing'), [], { env: {}, cwd: root, timeoutMs: 5000 });

        expect(missing.code).toBeNull();
        expect(missing.error).toBeDefined();
    });

    test('ends a program that does not end, with its children, at the deadline, and gives it no standard input', async () => {
        const started = Date.now();
        const slow = await runProgram(program('slow', 'sleep 30 & sleep 30'), [], {
            env: { PATH: process.env.PATH ?? '' },
            cwd: root,
            timeoutMs: 300,
        });

        expect(slow.timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(5000);

        const input = await runProgram(program('cat', 'cat; echo done'), [], {
            env: { PATH: process.env.PATH ?? '' },
            cwd: root,
            timeoutMs: 5000,
        });

        expect(input).toMatchObject({ code: 0, stdout: 'done\n' });
    });

    test('does not wait for what the program left running when it ended, which may hold its pipes open', async () => {
        const started = Date.now();
        const run = await runProgram(program('leftover', 'sleep 30 &\necho hi'), [], {
            env: { PATH: process.env.PATH ?? '' },
            cwd: root,
            timeoutMs: 20_000,
        });

        expect(run).toMatchObject({ code: 0, stdout: 'hi\n', timedOut: false });
        expect(Date.now() - started).toBeLessThan(5000);
    });

    test('asks a program to stop with the signal it was given, so it can clean up, and kills the one that ignores it after the grace', async () => {
        const env = { PATH: process.env.PATH ?? '' };
        /** Runs the program, stops it once it says it is ready (its trap is set), and answers what that came to. */
        const stopped = async (name: string, body: string) => {
            const ready = join(root, `${name}-ready`);
            const controller = new AbortController();
            const running = runProgram(
                program(name, `${body}\necho ready > '${ready}'\nwhile true; do sleep 1 & wait $!; done`),
                [],
                { env, cwd: root, timeoutMs: 30_000, stopSignal: 'SIGTERM', signal: controller.signal }
            );

            for (let i = 0; i < 500 && !existsSync(ready); i++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            controller.abort();

            return running;
        };
        const cleaned = join(root, 'cleaned');
        const pidFile = join(root, 'stubborn-pid');

        expect(await stopped('polite', `trap 'echo bye > ${cleaned}; exit 0' TERM`)).toMatchObject({
            error: 'stopped',
        });

        // The program saw `SIGTERM` and left in its own way: a `SIGKILL` would have given it no chance to say goodbye.
        // `runProgram` answers as soon as it has sent the signal, not when the program is gone: the trap may run a moment later, and a loaded machine makes it a long one.
        const said = () => (existsSync(cleaned) ? readFileSync(cleaned, 'utf8') : '');

        // The file exists a moment before its text does, so the text is what is waited for.
        for (let i = 0; i < 500 && said() === ''; i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        expect(said()).toBe('bye\n');

        expect(await stopped('stubborn', `echo $$ > ${pidFile}\ntrap '' TERM`)).toMatchObject({ error: 'stopped' });

        const pid = Number(readFileSync(pidFile, 'utf8'));
        const alive = () => {
            try {
                process.kill(pid, 0);

                return true;
            } catch {
                return false;
            }
        };

        // It shrugged the first signal off, and is gone once the grace (2 s) has passed.
        expect(alive()).toBe(true);

        for (let i = 0; i < 800 && alive(); i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        expect(alive()).toBe(false);
    });

    test('ends the program with its children when the signal fires, and starts nothing when it fired already', async () => {
        const pidFile = join(root, 'pid');
        const controller = new AbortController();
        const running = runProgram(program('long', `echo $$ > '${pidFile}'\nsleep 30 &\nsleep 30`), [], {
            env: { PATH: process.env.PATH ?? '' },
            cwd: root,
            timeoutMs: 20_000,
            signal: controller.signal,
        });

        for (let i = 0; i < 200 && !existsSync(pidFile); i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        controller.abort();

        expect(await running).toMatchObject({ code: null, error: 'stopped', timedOut: false });

        const pid = Number(readFileSync(pidFile, 'utf8'));
        const alive = () => {
            try {
                process.kill(pid, 0);

                return true;
            } catch {
                return false;
            }
        };

        for (let i = 0; i < 100 && alive(); i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        expect(alive()).toBe(false);
        expect(
            await runProgram(program('never', 'echo started'), [], {
                env: {},
                cwd: root,
                timeoutMs: 5000,
                signal: controller.signal,
            })
        ).toMatchObject({ code: null, stdout: '', error: 'stopped' });
    });
});

describe('Claude Code', () => {
    const signedIn = {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'ada@example.com',
        orgName: "Ada Lovelace's Organization",
        subscriptionType: 'max',
        planTier: 'max_5x',
    };

    test('reads who is signed in from `claude auth status --json`', () => {
        expect(parseClaudeStatus({ stdout: JSON.stringify(signedIn), stderr: '', timedOut: false })).toEqual({
            status: 'signed-in',
            account: { method: 'subscription', email: 'ada@example.com', plan: 'Max' },
        });
        expect(
            parseClaudeStatus({
                stdout: JSON.stringify({ ...signedIn, orgName: 'Analytical Engines' }),
                stderr: '',
                timedOut: false,
            }).account
        ).toMatchObject({ organization: 'Analytical Engines' });
        expect(
            parseClaudeStatus({
                stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }),
                stderr: '',
                timedOut: false,
            })
        ).toMatchObject({ status: 'signed-in', account: { method: 'api-key' }, detail: 'Signed in with an API key' });
        expect(
            parseClaudeStatus({
                stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
                stderr: '',
                timedOut: false,
            })
        ).toEqual({ status: 'signed-out' });
    });

    test('says unknown, with a reason, when the program cannot tell', () => {
        expect(parseClaudeStatus({ stdout: '', stderr: '', timedOut: true }).status).toBe('unknown');
        expect(parseClaudeStatus({ stdout: '', stderr: '', timedOut: false, error: 'spawn ENOENT' })).toMatchObject({
            status: 'unknown',
            detail: expect.stringContaining('ENOENT'),
        });
        expect(parseClaudeStatus({ stdout: 'error: unknown command', stderr: '', timedOut: false })).toMatchObject({
            status: 'unknown',
            detail: expect.stringContaining('unknown command'),
        });
    });

    test('shows the rows of the usage report as windows: session, weekly, weekly for a model', () => {
        const limits = [
            {
                kind: 'session',
                group: 'session',
                percent: 5,
                resets_at: '2026-11-18T20:00:00.505547+00:00',
                scope: null,
            },
            {
                kind: 'weekly_all',
                group: 'weekly',
                percent: 22,
                resets_at: '2026-11-24T15:00:00.505566+00:00',
                scope: null,
            },
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 0,
                resets_at: '2026-11-24T15:00:00+00:00',
                scope: { model: { display_name: 'Fable' }, surface: null },
            },
            { kind: 'something_new', percent: 150, resets_at: null },
            { kind: 'broken', percent: 'x' },
        ];

        expect(claudeWindows(limits)).toEqual([
            { id: 'session', label: 'Session', usedPercent: 5, resetsAt: Date.parse('2026-11-18T20:00:00Z') },
            { id: 'weekly', label: 'Week', usedPercent: 22, resetsAt: Date.parse('2026-11-24T15:00:00Z') },
            { id: 'weekly:fable', label: 'Fable', usedPercent: 0, resetsAt: Date.parse('2026-11-24T15:00:00Z') },
            { id: 'something_new', label: 'something new', usedPercent: 100 },
        ]);
    });

    test('lists the nearest limit first, whatever order the server gave: the session, then the week, then the weeks of single models', () => {
        const limits = [
            { kind: 'weekly_scoped', percent: 90, resets_at: null, scope: { model: { display_name: 'Fable' } } },
            { kind: 'weekly_all', percent: 40, resets_at: null, scope: null },
            { kind: 'session', percent: 0, resets_at: null, scope: null },
        ];

        expect(claudeWindows(limits).map(window => window.id)).toEqual(['session', 'weekly', 'weekly:fable']);
    });

    test('takes the report from the assistant line of the stream, and the text of an older Claude Code when there is none', () => {
        const report = {
            rate_limits: {
                limits: [
                    {
                        kind: 'session',
                        group: 'session',
                        percent: 8,
                        resets_at: '2026-11-18T20:00:00+00:00',
                        scope: null,
                    },
                ],
            },
        };
        const stream = [
            JSON.stringify({ type: 'system', subtype: 'init' }),
            JSON.stringify({
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'Current session: 8% used' }] },
                usage_report: report,
            }),
            JSON.stringify({ type: 'result', subtype: 'success' }),
        ].join('\n');

        expect(parseClaudeUsage(stream)).toEqual({
            state: 'ok',
            windows: [
                { id: 'session', label: 'Session', usedPercent: 8, resetsAt: Date.parse('2026-11-18T20:00:00Z') },
            ],
        });

        const old = JSON.stringify({
            type: 'assistant',
            message: {
                content: [
                    {
                        type: 'text',
                        text: 'Current session: 5% used · resets 5pm\nCurrent week (all models): 22% used · resets Nov 24\nCurrent week (Fable): 0% used',
                    },
                ],
            },
        });

        expect(parseClaudeUsage(old)).toEqual({
            state: 'ok',
            windows: [
                { id: 'session', label: 'Session', usedPercent: 5 },
                { id: 'weekly', label: 'Week', usedPercent: 22 },
                { id: 'weekly:fable', label: 'Fable', usedPercent: 0 },
            ],
        });
        expect(
            parseClaudeUsage(
                JSON.stringify({
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'Usage is rate limited until 3:14am' }] },
                })
            )
        ).toMatchObject({ state: 'error', detail: 'Usage is rate limited until 3:14am' });
        expect(parseClaudeUsage('')).toMatchObject({ state: 'error' });
    });

    test('says that the program is too old when it takes /usage for a skill that is not there, and what it said when it failed otherwise', () => {
        const unknown = [
            JSON.stringify({ type: 'system', subtype: 'init' }),
            JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Unknown skill: usage' }),
        ].join('\n');

        expect(parseClaudeUsage(unknown, '/opt/homebrew/bin/claude')).toEqual({
            state: 'error',
            windows: [],
            detail: 'Claude Code at /opt/homebrew/bin/claude is too old to report its limits. Update it, then try again',
        });
        expect(parseClaudeUsage(unknown)).toMatchObject({
            detail: 'Claude Code is too old to report its limits. Update it, then try again',
        });
        expect(parseClaudeUsage(JSON.stringify({ type: 'result', result: 'Something else went wrong' }))).toEqual({
            state: 'error',
            windows: [],
            detail: 'Claude Code did not report its limits: Something else went wrong',
        });
        expect(parseClaudeUsage(JSON.stringify({ type: 'result' }))).toEqual({
            state: 'error',
            windows: [],
            detail: 'Claude Code did not report its limits',
        });
    });

    test('names the program in the detail when an old Claude Code does not have /usage', async () => {
        writeFileSync(join(root, 'status.json'), JSON.stringify(signedIn));
        writeFileSync(
            join(root, 'usage.jsonl'),
            JSON.stringify({ type: 'result', is_error: false, result: 'Unknown skill: usage' })
        );

        const old = program(
            'claude-old',
            `if [ "$1" = auth ]; then cat '${join(root, 'status.json')}'; else cat '${join(root, 'usage.jsonl')}'; fi`
        );
        const read = await claudeAccount.read(context({ program: old }));

        expect(read.signIn.status).toBe('signed-in');
        expect(read.usage).toEqual({
            state: 'error',
            windows: [],
            detail: `Claude Code at ${old} is too old to report its limits. Update it, then try again`,
        });
    });

    test('reads the account and then the usage of a subscription from the program, and only the account for an API key', async () => {
        const stream = JSON.stringify({
            type: 'assistant',
            usage_report: {
                rate_limits: { limits: [{ kind: 'weekly_all', percent: 20, resets_at: '2026-11-24T15:00:00+00:00' }] },
            },
        });
        writeFileSync(join(root, 'status.json'), JSON.stringify(signedIn));
        writeFileSync(join(root, 'usage.jsonl'), stream);

        const subscription = program(
            'claude',
            `if [ "$1" = auth ]; then cat '${join(root, 'status.json')}'; else cat '${join(root, 'usage.jsonl')}'; fi`
        );
        const read = await claudeAccount.read(context({ program: subscription }));

        expect(read.signIn).toEqual({
            status: 'signed-in',
            account: { method: 'subscription', email: 'ada@example.com', plan: 'Max' },
        });
        expect(read.usage).toMatchObject({
            state: 'ok',
            fetchedAt: 1_000,
            windows: [{ id: 'weekly', label: 'Week', usedPercent: 20 }],
        });

        const key = program('claude-key', `echo '${JSON.stringify({ loggedIn: true, authMethod: 'api_key' })}'`);
        const keyed = await claudeAccount.read(context({ program: key }));

        expect(keyed.signIn.account?.method).toBe('api-key');
        expect(keyed.usage).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('no plan limits') });

        const out = program('claude-out', `echo '${JSON.stringify({ loggedIn: false })}'; exit 1`);

        expect(await claudeAccount.read(context({ program: out }))).toEqual({
            signIn: { status: 'signed-out' },
            usage: { state: 'unavailable', windows: [] },
        });
    });

    test('names a plan as a badge', () => {
        expect([planLabel('max'), planLabel('pro'), planLabel('team'), planLabel(null)]).toEqual([
            'Max',
            'Pro',
            'Team',
            undefined,
        ]);
    });
});

describe('Codex', () => {
    test('reads the account of `account/read`: ChatGPT, an API key, another provider, nobody', () => {
        expect(
            parseCodexAccount({
                account: { type: 'chatgpt', email: 'ada@example.com', planType: 'plus', workspaceName: null },
                requiresOpenaiAuth: true,
            })
        ).toEqual({ status: 'signed-in', account: { method: 'subscription', email: 'ada@example.com', plan: 'Plus' } });
        expect(
            parseCodexAccount({
                account: { type: 'chatgpt', email: null, planType: 'prolite', workspaceName: 'Engines' },
            }).account
        ).toEqual({ method: 'subscription', organization: 'Engines', plan: 'Pro Lite' });
        expect(parseCodexAccount({ account: { type: 'apiKey' } })).toMatchObject({
            status: 'signed-in',
            account: { method: 'api-key' },
        });
        expect(parseCodexAccount({ account: null, requiresOpenaiAuth: true })).toEqual({ status: 'signed-out' });
        expect(parseCodexAccount({ account: null, requiresOpenaiAuth: false }).status).toBe('signed-in');
        expect([
            codexPlan('self_serve_business_usage_based'),
            codexPlan('enterprise_cbp_usage_based'),
            codexPlan('unknown'),
            codexPlan('edu_plus'),
        ]).toEqual(['Business', 'Enterprise', undefined, 'Edu Plus']);
    });

    test('labels a window by its length, and falls back on the slot when it does not say', () => {
        expect([
            windowLabel(300, 'x'),
            windowLabel(10080, 'x'),
            windowLabel(1440, 'x'),
            windowLabel(180, 'x'),
            windowLabel(90, 'x'),
            windowLabel(null, 'Session'),
        ]).toEqual(['Session', 'Week', '1d', '3h', '90m', 'Session']);
    });

    test('shows the main bucket first, then the buckets of single models, with every window optional', () => {
        const response = {
            rateLimits: {
                limitId: 'codex',
                primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1_795_030_875 },
                secondary: null,
            },
            rateLimitsByLimitId: {
                spark: {
                    limitId: 'spark',
                    limitName: 'Codex Spark',
                    primary: null,
                    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_795_102_146 },
                },
                codex: {
                    limitId: 'codex',
                    limitName: null,
                    primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1_795_030_875 },
                    secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1_795_102_146 },
                },
            },
        };

        expect(codexWindows(response)).toEqual([
            { id: 'codex:primary', label: 'Session', usedPercent: 3, resetsAt: 1_795_030_875_000 },
            { id: 'codex:secondary', label: 'Week', usedPercent: 18, resetsAt: 1_795_102_146_000 },
            { id: 'spark:secondary', label: 'Codex Spark', usedPercent: 40, resetsAt: 1_795_102_146_000 },
        ]);
        expect(
            codexWindows({
                rateLimits: {
                    primary: { usedPercent: 9, windowDurationMins: null, resetsAt: null },
                    secondary: { usedPercent: 1, windowDurationMins: null, resetsAt: null },
                },
            })
        ).toEqual([
            { id: 'codex:primary', label: 'Session', usedPercent: 9 },
            { id: 'codex:secondary', label: 'Week', usedPercent: 1 },
        ]);
        expect(codexWindows({ rateLimits: null, rateLimitsByLimitId: null })).toEqual([]);
    });

    test('names a window of a single model for the model when it is the weekly one, and says which window it is otherwise', () => {
        const spark = {
            limitId: 'spark',
            limitName: 'Codex Spark',
            primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null },
            secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: null },
        };

        expect(codexWindows({ rateLimitsByLimitId: { spark } }).map(window => window.label)).toEqual([
            'Session (Codex Spark)',
            'Codex Spark',
        ]);
    });

    test('talks to `codex app-server`: initialize, account/read, account/rateLimits/read, one JSON message per line', async () => {
        // A scripted app-server: it answers each request by method and ignores the rest.
        const fake = program(
            'codex',
            `
            const rl = require('node:readline').createInterface({ input: process.stdin });
            const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
            rl.on('line', (line) => {
                const message = JSON.parse(line);
                if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });
                else if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt', email: 'ada@example.com', planType: 'plus', workspaceName: null }, requiresOpenaiAuth: true } });
                else if (message.method === 'account/rateLimits/read') { send({ method: 'account/rateLimits/updated', params: {} }); send({ id: message.id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1795030875 }, secondary: null }, rateLimitsByLimitId: null } }); }
                else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'unknown' } });
            });
        `,
            `#!${process.execPath}`
        );
        const read = await codexAccount.read(context({ program: fake }));

        expect(read.signIn).toEqual({
            status: 'signed-in',
            account: { method: 'subscription', email: 'ada@example.com', plan: 'Plus' },
        });
        expect(read.usage).toEqual({
            state: 'ok',
            fetchedAt: 1_000,
            windows: [{ id: 'codex:primary', label: 'Session', usedPercent: 3, resetsAt: 1_795_030_875_000 }],
        });
    });

    test('does not wait for the deadline for a program that ended in the middle of the conversation', async () => {
        const dying = program(
            'codex-dying',
            `
            const rl = require('node:readline').createInterface({ input: process.stdin });
            rl.on('line', (line) => {
                const message = JSON.parse(line);
                if (message.method === 'initialize') {
                    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
                    setTimeout(() => process.exit(3), 50);
                }
            });
        `,
            `#!${process.execPath}`
        );
        const started = Date.now();
        const read = withAppServer(
            context({ program: dying }),
            async rpc => {
                await rpc.call('initialize');
                await new Promise(resolve => setTimeout(resolve, 300));
                await rpc.call('account/read');
            },
            20_000
        );

        await expect(read).rejects.toThrow('ended before it answered');
        expect(Date.now() - started).toBeLessThan(5000);
    });

    test('stops the program and gives up when the daemon stops during a read', async () => {
        const silent = program('codex-silent', 'sleep 30', '#!/bin/sh');
        const controller = new AbortController();
        const started = Date.now();
        const read = codexAccount.read(context({ program: silent, signal: controller.signal }));

        setTimeout(() => controller.abort(), 100);

        expect(await read).toMatchObject({ signIn: { status: 'unknown' } });
        expect(Date.now() - started).toBeLessThan(5000);
    });

    test('keeps the account when only the limits fail, and says unknown when the program does not answer', async () => {
        const noLimits = program(
            'codex-nolimits',
            `
            const rl = require('node:readline').createInterface({ input: process.stdin });
            const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
            rl.on('line', (line) => {
                const message = JSON.parse(line);
                if (message.method === 'initialize') send({ id: message.id, result: {} });
                else if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt', email: 'ada@example.com', planType: 'pro' }, requiresOpenaiAuth: true } });
                else if (message.method === 'account/rateLimits/read') send({ id: message.id, error: { message: 'backend unavailable' } });
            });
        `,
            `#!${process.execPath}`
        );
        const partial = await codexAccount.read(context({ program: noLimits }));

        expect(partial.signIn.status).toBe('signed-in');
        expect(partial.usage).toMatchObject({ state: 'error', detail: expect.stringContaining('backend unavailable') });

        const dead = await codexAccount.read(context({ program: program('codex-dead', 'echo boom >&2; exit 2') }));

        expect(dead.signIn).toMatchObject({ status: 'unknown', detail: expect.stringContaining('boom') });

        const missing = await codexAccount.read(context({ program: join(root, 'not-here') }));

        expect(missing.signIn.status).toBe('unknown');
    });
});

describe('Cursor', () => {
    const home = () => join(root, 'home');

    function files(config: object | undefined, auth: object | undefined) {
        mkdirSync(join(home(), '.cursor'), { recursive: true });

        if (config) writeFileSync(join(home(), '.cursor', 'cli-config.json'), JSON.stringify(config));
        if (auth) writeFileSync(join(home(), '.cursor', 'auth.json'), JSON.stringify(auth));
    }

    test('turns the dashboard answer into the plan window and, when a limit is set, the on-demand one', () => {
        expect(cursorWindows({ billingCycleEnd: '1796000000000', planUsage: { totalPercentUsed: 9 } })).toEqual([
            { id: 'plan', label: 'Plan usage', usedPercent: 9, resetsAt: 1_796_000_000_000 },
        ]);
        expect(
            cursorWindows({
                billingCycleEnd: 1_796_000_000,
                planUsage: { totalPercentUsed: 9.5 },
                spendLimitUsage: { individualLimit: 2000, individualUsed: 500 },
            })
        ).toEqual([
            { id: 'plan', label: 'Plan usage', usedPercent: 9.5, resetsAt: 1_796_000_000_000 },
            { id: 'on-demand', label: 'On-demand', usedPercent: 25, resetsAt: 1_796_000_000_000 },
        ]);
        expect(cursorWindows({})).toEqual([]);
    });

    test('reads the identity and the token from the files of the command line', async () => {
        files({ authInfo: { email: 'ada@example.com', displayName: 'Ada' } }, { accessToken: 'secret-token' });

        const found = context();

        expect(readCursorIdentity(found)).toEqual({ email: 'ada@example.com', name: 'Ada' });
        expect(await readCursorToken(found)).toBe('secret-token');
        expect(await readCursorToken(context({ home: join(root, 'nobody') }))).toBeUndefined();
    });

    test("looks first in the folder the person's own CURSOR_CONFIG_DIR names, then in the usual ones", async () => {
        files({ authInfo: { email: 'usual@example.com' } }, { accessToken: 'usual-token' });

        const mine = join(root, 'mine');
        const own = (dir = mine) => context({ env: { PATH: process.env.PATH ?? '', CURSOR_CONFIG_DIR: dir } });

        mkdirSync(mine);
        writeFileSync(join(mine, 'cli-config.json'), JSON.stringify({ authInfo: { email: 'mine@example.com' } }));
        writeFileSync(join(mine, 'auth.json'), JSON.stringify({ accessToken: 'my-token' }));

        expect(readCursorIdentity(own())).toEqual({ email: 'mine@example.com' });
        expect(await readCursorToken(own())).toBe('my-token');
        // Without it, or with it empty, the person's own default folder is read as before.
        expect(readCursorIdentity(context())).toEqual({ email: 'usual@example.com' });
        expect(readCursorIdentity(own(''))).toEqual({ email: 'usual@example.com' });
        // A folder with nothing in it leaves the usual ones to answer.
        expect(readCursorIdentity(own(join(root, 'empty')))).toEqual({ email: 'usual@example.com' });
        expect(await readCursorToken(own(join(root, 'empty')))).toBe('usual-token');
        expect(
            cursorConfigDirs({
                platform: 'win32',
                home: home(),
                env: { CURSOR_CONFIG_DIR: 'C:\\mine', APPDATA: 'C:\\app' },
            })[0]
        ).toBe('C:\\mine');
    });

    test('signs nobody in without a token or an identity, and asks the dashboard with the token otherwise', async () => {
        expect(await cursorAccount.read(context())).toEqual({
            signIn: { status: 'signed-out' },
            usage: { state: 'unavailable', windows: [] },
        });

        files({ authInfo: { email: 'ada@example.com' } }, { accessToken: 'secret-token' });

        const calls: Array<{ url: string; auth: string | null; client: string | null }> = [];
        const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers);

            calls.push({
                url: String(url),
                auth: headers.get('authorization'),
                client: headers.get('x-cursor-client-type'),
            });

            return String(url).endsWith('GetPlanInfo')
                ? Response.json({ planInfo: { planName: 'Pro+' } })
                : Response.json({ billingCycleEnd: '1796000000000', planUsage: { totalPercentUsed: 5 } });
        }) as typeof fetch;
        const read = await cursorAccount.read(context({ fetch: fetcher }));

        expect(read.signIn).toEqual({
            status: 'signed-in',
            account: { method: 'subscription', email: 'ada@example.com', plan: 'Pro+' },
        });
        expect(read.usage).toEqual({
            state: 'ok',
            fetchedAt: 1_000,
            windows: [{ id: 'plan', label: 'Plan usage', usedPercent: 5, resetsAt: 1_796_000_000_000 }],
        });
        expect(calls.map(call => call.url).sort()).toEqual([
            'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
            'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo',
        ]);
        expect(calls.every(call => call.auth === 'Bearer secret-token' && call.client === 'cli')).toBe(true);
    });

    test('asks the dashboard without following a redirect, ignores a token that is not one, and never repeats the token in what it says', async () => {
        files({ authInfo: { email: 'ada@example.com' } }, { accessToken: 'bad token\nsecond line' });

        expect(await readCursorToken(context())).toBeUndefined();

        files({ authInfo: { email: 'ada@example.com' } }, { accessToken: 'secret-token' });

        const inits: Array<RequestInit | undefined> = [];
        const leaky = await cursorAccount.read(
            context({
                fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
                    inits.push(init);

                    throw new Error('could not reach Bearer secret-token');
                }) as unknown as typeof fetch,
            })
        );

        expect(inits.length).toBeGreaterThan(0);
        expect(inits.every(init => init?.redirect === 'error')).toBe(true);
        expect(leaky.usage).toMatchObject({ state: 'error', detail: 'could not reach Bearer …' });
        expect(JSON.stringify(leaky)).not.toContain('secret-token');
    });

    test('keeps the account and says why when the dashboard refuses or fails', async () => {
        files({ authInfo: { email: 'ada@example.com' } }, { accessToken: 'stale' });

        const refused = await cursorAccount.read(
            context({ fetch: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch })
        );

        expect(refused.signIn.status).toBe('signed-in');
        expect(refused.usage).toMatchObject({ state: 'error', detail: expect.stringContaining('sign in again') });

        const down = await cursorAccount.read(
            context({
                fetch: (async () => {
                    throw new Error('offline');
                }) as unknown as typeof fetch,
            })
        );

        expect(down.usage).toMatchObject({ state: 'error', detail: 'offline' });

        mkdirSync(join(root, 'other', '.cursor'), { recursive: true });
        writeFileSync(join(root, 'other', '.cursor', 'auth.json'), JSON.stringify({ accessToken: 'stale' }));

        const noIdentity = await cursorAccount.read(
            context({
                home: join(root, 'other'),
                fetch: (async () => new Response('no', { status: 403 })) as unknown as typeof fetch,
            })
        );

        expect(noIdentity.signIn).toMatchObject({ status: 'signed-out', detail: 'The Cursor login has expired' });
    });
});
