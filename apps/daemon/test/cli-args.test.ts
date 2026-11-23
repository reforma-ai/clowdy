import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { commandOf, commandText, flagsOf, helpOf, parseCommand, summaryOf, UsageError } from '../src/cli/args';
import { readSource, runCli } from '../src/cli/clowdy';
import { threadTools } from '../src/runs/thread-tools';
import { cleanTempDirs, tempDir } from './helpers';

import type { CliTool } from '../src/cli/args';
import type { StdinSource } from '../src/cli/clowdy';
import type { ToolDefinition } from '../src/engine/types';

afterAll(cleanTempDirs);

const spawn: CliTool = {
    name: 'thread_spawn',
    description:
        'Starts a thread: a new chat below yours (with an agent) that works on the prompt. Then more text that thread_list explains.',
    inputSchema: {
        properties: {
            prompt: { type: 'string', description: 'The assignment' },
            title: { type: 'string' },
            mode: { type: 'string', enum: ['autopilot', 'semi'] },
            tasks: { type: 'array', items: { type: 'string' } },
            timeoutSeconds: { type: 'integer' },
            fresh: { type: 'boolean' },
        },
        required: ['prompt'],
    },
};

const tell: CliTool = {
    name: 'thread_tell',
    description: 'Sends a message to a thread.',
    inputSchema: {
        properties: {
            thread: { type: 'string', description: 'The thread' },
            message: { type: 'string' },
            mode: { type: 'string', enum: ['steer', 'queue'] },
        },
        required: ['thread', 'message'],
    },
    positional: ['thread', 'message'],
    stdin: 'message',
};

const get: CliTool = {
    name: 'task_get',
    description: 'Reads one task.',
    inputSchema: { properties: { taskId: { type: 'string', description: 'A task key' } }, required: ['taskId'] },
    positional: ['taskId'],
};

/** A command whose bare words are a list: `clowdy task archive CLW-1 CLW-2 --cancel`. */
const archive: CliTool = {
    name: 'task_archive',
    description: 'Archives closed tasks.',
    inputSchema: {
        properties: {
            taskId: { type: 'array', items: { type: 'string' }, description: 'The tasks to archive' },
            cancel: { type: 'boolean' },
        },
        required: ['taskId'],
    },
    positional: ['taskId'],
};

const list: CliTool = {
    name: 'thread_list',
    description: 'Lists your threads.',
    inputSchema: { properties: { all: { type: 'boolean' } } },
};

describe('parseCommand', () => {
    test('flags become fields: kebab-case names, both spellings of a value, typed values', () => {
        const parsed = parseCommand(spawn, [
            '--prompt',
            'Do it',
            '--title=A title',
            '--timeout-seconds',
            '30',
            '--mode',
            'semi',
        ]);

        expect(parsed).toEqual({
            arguments: { prompt: 'Do it', title: 'A title', timeoutSeconds: 30, mode: 'semi' },
            files: {},
            json: false,
            help: false,
        });
    });

    test('a list takes repeated flags and commas, a boolean its bare flag and its negation', () => {
        expect(
            parseCommand(spawn, ['--prompt', 'x', '--tasks', 'CLW-1,CLW-2', '--tasks', 'CLW-3', '--fresh']).arguments
        ).toEqual({ prompt: 'x', tasks: ['CLW-1', 'CLW-2', 'CLW-3'], fresh: true });
        expect(parseCommand(spawn, ['--prompt', 'x', '--no-fresh']).arguments).toEqual({ prompt: 'x', fresh: false });
    });

    test('--<name>-file names a file or stdin for a text field, which the caller reads, and counts as the field', () => {
        expect(parseCommand(spawn, ['--prompt-file', 'brief.md'])).toMatchObject({
            arguments: {},
            files: { prompt: 'brief.md' },
        });
        expect(parseCommand(spawn, ['--prompt-file', '-', '--title-file=title.txt'])).toMatchObject({
            arguments: {},
            files: { prompt: '-', title: 'title.txt' },
        });
    });

    test('bare words fill the positional fields, the last text field takes every word left, and a bare - is stdin', () => {
        expect(parseCommand(tell, ['thr_1', 'please', 'stop', 'now', '--mode', 'queue']).arguments).toEqual({
            thread: 'thr_1',
            message: 'please stop now',
            mode: 'queue',
        });
        expect(parseCommand(tell, ['thr_1', '-'])).toMatchObject({
            arguments: { thread: 'thr_1' },
            files: { message: '-' },
        });
        expect(parseCommand(tell, ['thr_1', '--message-file', 'note.md'])).toMatchObject({
            arguments: { thread: 'thr_1' },
            files: { message: 'note.md' },
        });
        // A `-` in the place of a word that is not the last is just a value.
        expect(parseCommand(tell, ['-', 'hello'])).toMatchObject({
            arguments: { thread: '-', message: 'hello' },
            files: {},
        });
        // Only the field the tool names for stdin reads it: the id of a task that is last is still a value.
        expect(parseCommand(get, ['-'])).toMatchObject({ arguments: { taskId: '-' }, files: {} });
    });

    test('a positional list takes every bare word left, each of which may hold several items with commas, and the flags go anywhere', () => {
        expect(parseCommand(archive, ['CLW-1']).arguments).toEqual({ taskId: ['CLW-1'] });
        expect(parseCommand(archive, ['CLW-1', 'CLW-2', 'CLW-3']).arguments).toEqual({
            taskId: ['CLW-1', 'CLW-2', 'CLW-3'],
        });
        expect(parseCommand(archive, ['CLW-1,CLW-2', 'CLW-3', ' , CLW-4']).arguments).toEqual({
            taskId: ['CLW-1', 'CLW-2', 'CLW-3', 'CLW-4'],
        });
        expect(parseCommand(archive, ['CLW-1', '--cancel', 'CLW-2']).arguments).toEqual({
            taskId: ['CLW-1', 'CLW-2'],
            cancel: true,
        });
        expect(parseCommand(archive, ['--cancel', 'CLW-1', 'CLW-2']).arguments).toEqual({
            taskId: ['CLW-1', 'CLW-2'],
            cancel: true,
        });
        expect(parseCommand(archive, ['--', 'CLW-1', '--cancel']).arguments).toEqual({ taskId: ['CLW-1', '--cancel'] });
        // The same field as an option takes a list too, repeated or with commas; a stdin dash is just a word.
        expect(parseCommand(archive, ['--task-id', 'CLW-1,CLW-2', '--task-id', 'CLW-3']).arguments).toEqual({
            taskId: ['CLW-1', 'CLW-2', 'CLW-3'],
        });
        expect(parseCommand(archive, ['-'])).toMatchObject({ arguments: { taskId: ['-'] }, files: {} });
    });

    test('everything after -- is bare, so a message may start with dashes', () => {
        expect(parseCommand(tell, ['thr_1', '--', '--mode', 'is', 'text']).arguments).toEqual({
            thread: 'thr_1',
            message: '--mode is text',
        });
    });

    test("--json, --help and -h are the program's own", () => {
        expect(parseCommand(spawn, ['--json', '--prompt', 'x'])).toEqual({
            arguments: { prompt: 'x' },
            files: {},
            json: true,
            help: false,
        });
        expect(parseCommand(spawn, ['--help'])).toMatchObject({ help: true, arguments: {} });
        expect(parseCommand(tell, ['-h'])).toMatchObject({ help: true, arguments: {} });
    });

    test.each([
        [spawn, ['--nope', 'x'], 'Unknown option --nope'],
        [spawn, ['--prompt'], '--prompt needs a value'],
        [spawn, ['--prompt', 'x', '--timeout-seconds', 'soon'], 'whole number'],
        [spawn, ['--prompt', 'x', '--mode', 'wild'], 'one of autopilot, semi'],
        [spawn, [], 'Missing --prompt'],
        [spawn, ['--prompt', 'x', 'stray'], 'Unexpected "stray"'],
        [spawn, ['--prompt', 'x', '--prompt', 'y'], '--prompt is given twice'],
        [spawn, ['--prompt', 'x', '--prompt-file', 'brief.md'], '--prompt is given twice'],
        [spawn, ['--prompt-file', '-', '--title-file', '-'], 'Only one text can come from stdin'],
        [tell, ['thr_1'], 'Missing <message>'],
        [archive, [], 'Missing <task-id>'],
        [archive, ['--cancel'], 'Missing <task-id>'],
        [archive, [',', ' '], 'Missing <task-id>'],
        [archive, ['CLW-1', '--task-id', 'CLW-2'], 'task-id is given twice'],
        [tell, ['thr_1', 'hello', '--message', 'again'], 'given twice'],
        [list, ['--all=maybe'], 'takes true or false'],
    ] as const)('a command line that cannot be understood is refused with what to fix: %#', (tool, words, message) => {
        expect(() => parseCommand(tool, words)).toThrow(UsageError);
        expect(() => parseCommand(tool, words)).toThrow(message);
    });
});

describe('commandOf, flagsOf, summaryOf, commandText and helpOf', () => {
    test('a tool is a group and a command, and its flags are its fields with their negation and file forms', () => {
        expect(commandOf({ name: 'thread_spawn' })).toEqual({ group: 'thread', command: 'spawn' });
        expect(commandOf({ name: 'thread_wait_all' })).toEqual({ group: 'thread', command: 'wait-all' });
        expect(flagsOf(spawn).sort()).toEqual([
            'fresh',
            'mode',
            'mode-file',
            'no-fresh',
            'prompt',
            'prompt-file',
            'tasks',
            'timeout-seconds',
            'title',
            'title-file',
        ]);
    });

    test("the real thread_spawn takes --worktree and --no-worktree, and its help says what the option does and that merging the branch back is the parent's", () => {
        const real = threadTools(
            { threads: undefined as never, store: undefined as never, runs: undefined as never },
            {} as never
        ).find((tool: ToolDefinition) => tool.name === 'thread_spawn') as unknown as CliTool;

        expect(flagsOf(real)).toEqual(expect.arrayContaining(['worktree', 'no-worktree', 'cwd']));
        expect(parseCommand(real, ['--prompt', 'x', '--worktree']).arguments).toEqual({ prompt: 'x', worktree: true });
        expect(parseCommand(real, ['--prompt', 'x', '--no-worktree']).arguments).toEqual({
            prompt: 'x',
            worktree: false,
        });
        expect(parseCommand(real, ['--prompt', 'x', '--worktree', '--cwd', '/work/copy']).arguments).toEqual({
            prompt: 'x',
            worktree: true,
            cwd: '/work/copy',
        });

        const help = helpOf(real);

        expect(help).toMatch(/--worktree\s+Gives the thread a git worktree of its own/);
        expect(help).toContain('Bringing the branch back is your job, with git');
        expect(help).toContain('Not together with cwd');
    });

    test('a summary is the first sentence without brackets, cut at its colon when long', () => {
        expect(summaryOf(spawn.description)).toBe('Starts a thread: a new chat below yours that works on the prompt');
        expect(
            summaryOf(
                "Stops a thread below you as the person's Stop does: its running turn and the work it has open in the background end, and more."
            )
        ).toBe("Stops a thread below you as the person's Stop does");
        expect(summaryOf('Lists your threads (all of them). Then more.')).toBe('Lists your threads');
    });

    test("a tool's text names the other tools as the commands they are", () => {
        expect(commandText('Use thread_list or thread_spawn, not thread_spawner.', [spawn, list])).toBe(
            'Use clowdy thread list or clowdy thread spawn, not thread_spawner.'
        );
    });

    test('the help names the usage, the positional words, the options, the file form of a required text, and the examples', () => {
        const help = helpOf(tell);

        expect(help).toContain('Usage: clowdy thread tell <thread> <message> [options]');
        expect(help).toContain('<thread>');
        expect(help).toContain('(- reads it from stdin)');
        expect(help.match(/reads it from stdin/g)).toHaveLength(1);
        expect(helpOf(get)).not.toContain('stdin');
        expect(help).toContain('--mode <steer|queue>');
        expect(help).toContain('--json');

        const spawnHelp = helpOf(spawn, [spawn, list], ["clowdy thread spawn --prompt-file - <<'EOF'"]);

        expect(spawnHelp).toContain('--prompt <text>');
        expect(spawnHelp).toContain('--prompt-file <path>');
        expect(spawnHelp).not.toContain('--title-file');
        expect(spawnHelp).toContain('(required)');
        expect(spawnHelp).toContain('--tasks <a,b,...>');
        expect(spawnHelp).toContain('--timeout-seconds <n>');
        expect(spawnHelp).toContain('that clowdy thread list explains');
        expect(spawnHelp).toContain('Examples:\n  clowdy thread spawn --prompt-file -');
    });

    test('the help writes a positional list as one word or more, and does not list it again among the options', () => {
        const help = helpOf(archive);

        expect(help).toContain('Usage: clowdy task archive <task-id>... [options]');
        expect(help).toMatch(/Arguments:\n {2}<task-id>\.\.\. +The tasks to archive/);
        expect(help).toContain('--cancel');
        expect(help).not.toContain('--task-id');
        expect(helpOf({ ...archive, inputSchema: { properties: archive.inputSchema.properties } })).toContain(
            'clowdy task archive [task-id] [options]'
        );
    });
});

describe('readSource', () => {
    const stdin = (chunks: string[] | 'silent', isTTY = false): StdinSource => ({
        isTTY,
        stream: () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    if (chunks === 'silent') {
                        return;
                    }

                    for (const chunk of chunks) {
                        controller.enqueue(new TextEncoder().encode(chunk));
                    }

                    controller.close();
                },
            }),
    });

    test('reads a file and stdin to their end, without the trailing line breaks a heredoc ends with', async () => {
        const file = join(tempDir(), 'brief.md');

        writeFileSync(file, 'Line one\nLine two\n\n');

        expect(await readSource(file)).toBe('Line one\nLine two');
        expect(await readSource('-', stdin(['Fix the ', 'login bug\n', 'and report\n']))).toBe(
            'Fix the login bug\nand report'
        );
    });

    test('refuses a missing file, a terminal, an empty stdin and a stdin that stays silent, instead of hanging', async () => {
        await expect(readSource(join(tempDir(), 'missing.md'))).rejects.toThrow(/Cannot read .*missing\.md/);
        await expect(readSource('-', stdin(['x'], true))).rejects.toThrow('stdin is a terminal');
        await expect(readSource('-', stdin([]))).rejects.toThrow('stdin was empty');
        await expect(readSource('-', stdin(['\n\n']))).rejects.toThrow('stdin was empty');

        const started = Date.now();

        await expect(readSource('-', stdin('silent'), 100)).rejects.toThrow(UsageError);
        expect(Date.now() - started).toBeLessThan(2000);
    });
});

describe('runCli', () => {
    const tools = [spawn, tell, list];

    function harness(
        respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
        env: Record<string, string> = { CLOWDY_CLI_URL: 'http://daemon', CLOWDY_CLI_AUTH: 'secret' }
    ) {
        const out: string[] = [];
        const err: string[] = [];
        const reads: string[] = [];
        const calls: { url: string; body?: unknown; authorization?: string }[] = [];
        const io = {
            env,
            fetch: (async (url: string, init?: RequestInit) => {
                calls.push({
                    url,
                    body: init?.body ? JSON.parse(init.body as string) : undefined,
                    authorization: (init?.headers as Record<string, string>).authorization,
                });

                return respond(url, init);
            }) as unknown as typeof fetch,
            readText: (source: string) => {
                reads.push(source);

                if (source === 'missing.md') {
                    throw new UsageError('Cannot read missing.md');
                }

                return `text of ${source}`;
            },
            stdout: (text: string) => void out.push(text),
            stderr: (text: string) => void err.push(text),
        };

        return { io, out, err, calls, reads };
    }

    const answering = (answer: { isError: boolean; text: string }) => (url: string) =>
        url.endsWith('/cli/tools') ? Response.json({ tools }) : Response.json(answer);
    const listing = answering({ isError: false, text: '{"threadId":"cht_1"}' });

    test('a command calls its tool with the typed input and the session credential, and prints the text', async () => {
        const { io, out, calls } = harness(listing);

        expect(await runCli(['thread', 'tell', 'cht_1', 'hello', 'there'], io)).toBe(0);
        expect(calls.at(-1)).toEqual({
            url: 'http://daemon/call',
            body: { name: 'thread_tell', arguments: { thread: 'cht_1', message: 'hello there' } },
            authorization: 'Bearer secret',
        });
        expect(out).toEqual(['{"threadId":"cht_1"}']);
    });

    test('a text from a file or stdin is read before the call and sent as the field', async () => {
        const { io, calls, reads } = harness(listing);

        expect(await runCli(['thread', 'spawn', '--prompt-file', '-', '--title', 'Cache'], io)).toBe(0);
        expect(reads).toEqual(['-']);
        expect(calls.at(-1)?.body).toEqual({
            name: 'thread_spawn',
            arguments: { prompt: 'text of -', title: 'Cache' },
        });

        const missing = harness(listing);

        expect(await runCli(['thread', 'spawn', '--prompt-file', 'missing.md'], missing.io)).toBe(2);
        expect(missing.err[0]).toContain('Cannot read missing.md');
        expect(missing.calls).toHaveLength(1);
    });

    test('--json wraps a result in one object, and a failure in one with its code on stdout, with the message on stderr too', async () => {
        const ok = harness(listing);

        expect(await runCli(['thread', 'tell', 'cht_1', 'hi', '--json'], ok.io)).toBe(0);
        expect(JSON.parse(ok.out[0])).toEqual({ ok: true, result: { threadId: 'cht_1' } });

        const refused = harness(answering({ isError: true, text: 'Not your thread' }));

        expect(await runCli(['thread', 'tell', 'cht_1', 'hi', '--json'], refused.io)).toBe(1);
        expect(JSON.parse(refused.out[0])).toEqual({
            ok: false,
            error: { code: 'refused', message: 'Not your thread' },
        });
        expect(refused.err).toEqual(['Not your thread']);

        const usage = harness(listing);

        expect(await runCli(['thread', 'tell', '--json', 'cht_1'], usage.io)).toBe(2);
        expect(JSON.parse(usage.out[0])).toMatchObject({
            ok: false,
            error: { code: 'usage', message: expect.stringContaining('Missing <message>') },
        });

        // After `--` it is the message, not the option.
        const literal = harness(listing);

        expect(await runCli(['thread', 'tell', 'cht_1', '--', '--json'], literal.io)).toBe(0);
        expect(literal.out).toEqual(['{"threadId":"cht_1"}']);
    });

    test('a refusal exits 1 with the text, a bad command line 2, an unknown command 2 with the commands', async () => {
        const refused = harness(answering({ isError: true, text: 'Not your thread' }));

        expect(await runCli(['thread', 'tell', 'cht_1', 'hi'], refused.io)).toBe(1);
        expect(refused.err).toEqual(['Not your thread']);

        const usage = harness(listing);

        expect(await runCli(['thread', 'tell', 'cht_1'], usage.io)).toBe(2);
        expect(usage.err[0]).toContain('Missing <message>');
        expect(usage.err[0]).toContain('Run clowdy thread tell --help');
        expect(usage.calls).toHaveLength(1);

        const unknown = harness(listing);

        expect(await runCli(['thread', 'nope'], unknown.io)).toBe(2);
        expect(unknown.err[0]).toContain('Unknown command "thread nope"');
        expect(unknown.err[0]).toContain('thread tell');

        const group = harness(listing);

        expect(await runCli(['task', 'list'], group.io)).toBe(2);
        expect(group.err[0]).toContain('Unknown command "task"');
    });

    test('every way of asking for help prints usage and calls nothing', async () => {
        const { io, out, calls } = harness(listing);

        for (const argv of [[], ['--help'], ['help'], ['-h']]) {
            expect(await runCli(argv, io)).toBe(0);
            expect(out.at(-1)).toContain('Usage: clowdy <group> <command>');
        }

        const all = out.at(-1) as string;

        expect(all).toContain('thread spawn');
        expect(all).toContain('Starts a thread: a new chat below yours that works on the prompt');
        expect(all).toContain('The common flow:');
        expect(all).toContain('clowdy thread spawn --title "Fix the login bug" --prompt-file - <<\'EOF\'');
        expect(all).toContain('Exit codes: 0 done; 1');
        // The example of a command the session does not have is left out.
        expect(all).not.toContain('clowdy thread wait');

        for (const argv of [['thread'], ['thread', '--help'], ['thread', 'help'], ['help', 'thread']]) {
            expect(await runCli(argv, io)).toBe(0);
            expect(out.at(-1)).toContain('Usage: clowdy thread <command>');
        }

        for (const argv of [
            ['thread', 'tell', '--help'],
            ['thread', 'tell', '-h'],
            ['help', 'thread', 'tell'],
        ]) {
            expect(await runCli(argv, io)).toBe(0);
            expect(out.at(-1)).toContain('Usage: clowdy thread tell <thread> <message>');
        }

        expect(calls.every(call => call.url.endsWith('/cli/tools'))).toBe(true);
    });

    test('no session environment, a dead daemon, an ended session and an odd answer exit 4 with the reason', async () => {
        const outside = harness(listing, {});

        expect(await runCli(['thread', 'list'], outside.io)).toBe(4);
        expect(outside.err[0]).toContain('inside an agent session');

        const dead = harness(() => {
            throw new Error('connection refused');
        });

        expect(await runCli(['thread', 'list'], dead.io)).toBe(4);
        expect(dead.err[0]).toContain('connection refused');
        expect(dead.err[0]).not.toContain('escalated');

        // A sandboxed shell (Codex's) refuses the connection with EPERM: the error tells the agent how to get out.
        const sandboxed = harness(() => {
            throw new Error('EPERM: Was there a typo in the url or port?');
        });

        expect(await runCli(['thread', 'list'], sandboxed.io)).toBe(4);
        expect(sandboxed.err[0]).toContain(
            'run the same command again with escalated permissions, outside the sandbox'
        );

        const ended = harness(() => new Response('unauthorized', { status: 401 }));

        expect(await runCli(['thread', 'list'], ended.io)).toBe(4);
        expect(ended.err[0]).toContain('no longer valid');

        // The session ends between the listing and the call.
        const endedLater = harness(url =>
            url.endsWith('/cli/tools') ? Response.json({ tools }) : new Response('unauthorized', { status: 401 })
        );

        expect(await runCli(['thread', 'list', '--json'], endedLater.io)).toBe(4);
        expect(JSON.parse(endedLater.out[0])).toMatchObject({
            ok: false,
            error: { code: 'unreachable', message: expect.stringContaining('no longer valid') },
        });

        const odd = harness(() => new Response('boom', { status: 500 }));

        expect(await runCli(['thread', 'list'], odd.io)).toBe(4);
        expect(odd.err[0]).toContain('HTTP 500');
    });
});
