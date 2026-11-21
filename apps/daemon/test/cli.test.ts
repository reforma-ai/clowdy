import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { flagsOf } from '../src/cli/args';
import { EXAMPLES } from '../src/cli/clowdy';
import { CLI_ENTRY, installShim } from '../src/cli/shim';
import { getChat } from '../src/db/chats';
import { listItems } from '../src/db/items';
import { ToolBridge } from '../src/engine/acp/bridge';
import { toolsFor } from '../src/runs/tools';
import { collect, FAKE_AGENT, PROTOCOLS, rig, textOf, tool } from './acp-helpers';
import { cleanTempDirs, latch, ScriptEngine, scriptEngines, startHarness, tempDir, waitFor } from './helpers';

import type { Chat } from '@clowdy/protocol';
import type { CliTool } from '../src/cli/args';
import type { Shim } from '../src/cli/shim';
import type { ToolDefinition } from '../src/engine/types';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];
const bridges: ToolBridge[] = [];

afterEach(async () => {
    bridges.splice(0).forEach(bridge => bridge.stop());
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

interface Ran {
    code: number;
    stdout: string;
    stderr: string;
}

/** Runs `argv` and collects what it printed. `stdin` is text to pipe in, `'ignore'` an empty one, `'open'` a pipe nobody writes to or closes. */
async function run(argv: string[], { env = {}, cwd, stdin = 'ignore' }: { env?: Record<string, string | undefined>; cwd?: string; stdin?: string | 'ignore' | 'open' } = {}): Promise<Ran> {
    const child = Bun.spawn(argv, {
        cwd,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        stdin: stdin === 'ignore' ? 'ignore' : stdin === 'open' ? 'pipe' : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

    return { code, stdout, stderr };
}

/** A tool that is also a shell command. */
function command(name: string, execute: ToolDefinition['execute'], positional?: string[]): ToolDefinition {
    return { ...tool(name, execute), cli: positional ? { positional } : {} };
}

/** A script that says `say`, then holds until `gate` is released (or the run is stopped), then ends. */
function held(gate: ReturnType<typeof latch>, say = 'working'): Script {
    return async function* ({ number, signal }) {
        yield { type: 'session', sessionId: `s-${ number }` };
        yield { type: 'text', delta: say, done: true };
        await gate.wait(signal);
        yield { type: 'done', result: say };
    };
}

describe('the shim', () => {
    test('is a POSIX script that runs the CLI with the daemon\'s Bun, kept out of the project\'s bunfig.toml and .env, and rewritten only when it changed', () => {
        const dataDir = tempDir();
        const shim = installShim(dataDir, { platform: 'darwin' });
        const file = join(dataDir, 'bin', 'clowdy');

        expect(shim).toEqual({ dir: join(dataDir, 'bin'), command: file });
        expect(readFileSync(file, 'utf8')).toBe([
            '#!/bin/sh',
            '# The clowdy command of the Clowdy daemon, written again at every start: do not edit',
            `exec '${ process.execPath }' --no-env-file '--config=${ join(dataDir, 'bin', 'bunfig.toml') }' '${ CLI_ENTRY }' "$@"`,
            '',
        ].join('\n'));
        expect(statSync(file).mode & 0o777).toBe(0o755);
        expect(readFileSync(join(dataDir, 'bin', 'bunfig.toml'), 'utf8')).toBe('');
        expect(existsSync(join(dataDir, 'bin', 'clowdy.cmd'))).toBe(false);

        // The same content is left alone (a rename would give the file a new inode); a changed file or mode is put back.
        const { ino } = statSync(file);

        installShim(dataDir, { platform: 'darwin' });
        expect(statSync(file).ino).toBe(ino);

        writeFileSync(file, '#!/bin/sh\necho stale\n');
        chmodSync(file, 0o644);
        installShim(dataDir, { platform: 'darwin' });
        expect(readFileSync(file, 'utf8')).toContain(CLI_ENTRY);
        expect(statSync(file).mode & 0o777).toBe(0o755);

        const moved = installShim(dataDir, { platform: 'darwin', entry: '/elsewhere/clowdy.js' });

        expect(readFileSync(moved.command, 'utf8')).toContain('\'/elsewhere/clowdy.js\' "$@"');
    });

    test('on Windows is also a .cmd beside the script, with % written twice', () => {
        const dataDir = tempDir();
        const shim = installShim(dataDir, { platform: 'win32', runtime: 'C:\\Program Files\\Clowdy\\bun.exe', entry: 'C:\\Users\\Jo 100%\\clowdy.js' });

        expect(shim.command).toBe(join(dataDir, 'bin', 'clowdy.cmd'));
        expect(readFileSync(shim.command, 'utf8')).toBe([
            '@echo off',
            'rem The clowdy command of the Clowdy daemon, written again at every start: do not edit',
            `"C:\\Program Files\\Clowdy\\bun.exe" --no-env-file "--config=${ join(dataDir, 'bin', 'bunfig.toml') }" "C:\\Users\\Jo 100%%\\clowdy.js" %*`,
            '',
        ].join('\r\n'));
        expect(existsSync(join(dataDir, 'bin', 'clowdy'))).toBe(true);
    });

    test('works from folders with spaces, quotes and dollars, passes every argument as it is, and keeps the project\'s config and .env out', async () => {
        const dataDir = join(tempDir(), 'Application Support', 'it\'s "Clowdy" $HOME');
        const entry = join(tempDir(), 'my "cli" folder\'s $PATH', 'echo.ts');
        const project = tempDir();

        mkdirSync(dirname(entry), { recursive: true });
        writeFileSync(entry, 'console.log(JSON.stringify({ args: process.argv.slice(2), dotenv: process.env.FROM_DOTENV ?? null, cwd: process.cwd() }));\n');
        writeFileSync(join(project, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
        writeFileSync(join(project, 'preload.ts'), 'console.log("the project preload ran");\n');
        writeFileSync(join(project, '.env'), 'FROM_DOTENV=1\n');

        const shim = installShim(dataDir, { entry });
        const args = ['a b', 'it\'s', '"quoted"', '$HOME', '', '--json'];
        const ran = await run([shim.command, ...args], { cwd: project });

        expect(ran.stderr).toBe('');
        expect(ran.code).toBe(0);
        expect(JSON.parse(ran.stdout)).toEqual({ args, dotenv: null, cwd: expect.stringContaining(project.split('/').at(-1) as string) });
    });

    test('really runs the CLI, from the PATH, against a registered bridge, and a large output arrives whole', async () => {
        const shim = installShim(tempDir());
        const bridge = new ToolBridge();
        const big = 'x'.repeat(2_000_000);

        bridges.push(bridge);

        const access = bridge.register([command('thread_list', async () => ({ threads: [] })), command('thread_log', async () => big, ['thread'])], new AbortController().signal);
        const env = { PATH: `${ shim.dir }${ delimiter }${ process.env.PATH }`, CLOWDY_CLI_URL: access.cli?.url, CLOWDY_CLI_AUTH: access.cli?.auth };

        const help = await run(['sh', '-c', 'clowdy --help'], { env });

        expect(help.code).toBe(0);
        expect(help.stdout).toContain('Usage: clowdy <group> <command>');
        expect(help.stdout).toContain('thread list');

        expect(await run(['sh', '-c', 'clowdy thread list'], { env })).toEqual({ code: 0, stdout: '{"threads":[]}\n', stderr: '' });

        const log = await run([shim.command, 'thread', 'log', 'cht_1'], { env });

        expect(log.code).toBe(0);
        expect(log.stdout.length).toBe(big.length + 1);

        // A reader that stops early does not hang the command.
        const head = await run(['sh', '-c', 'clowdy thread log cht_1 | head -c 5'], { env });

        expect(head.stdout).toBe('xxxxx');
    });

    test('waits for a call that stays silent longer than Bun\'s idle limit of a request, as a long thread wait does', async () => {
        const shim = installShim(tempDir());
        const bridge = new ToolBridge();

        bridges.push(bridge);

        const access = bridge.register([command('thread_wait', async () => {
            await Bun.sleep(10_000);

            return 'rested';
        }, ['thread'])], new AbortController().signal);
        // Bun gives up on a request whose connection is silent for its idle limit: 5 minutes by default, under the 10 minutes a wait may take. One
        // second here, which its coarse timer turns into about 8.
        const env = { CLOWDY_CLI_URL: access.cli?.url, CLOWDY_CLI_AUTH: access.cli?.auth, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' };

        expect(await run([shim.command, 'thread', 'wait', 'cht_1'], { env })).toEqual({ code: 0, stdout: 'rested\n', stderr: '' });
    }, 30_000);
});

describe('clowdy in an agent\'s shell, against a daemon', () => {
    /**
     * A daemon whose chat "Plan the release" holds its first turn, with that orchestrator's real tools registered on a real bridge the way a session
     * registers them, and the shim the daemon wrote at start first on the shell's `PATH`.
     */
    async function setup() {
        const routes: [string, Script][] = [];
        const engine = new ScriptEngine(async function* (turn) {
            const route = routes.find(([ending]) => turn.options.prompt.endsWith(ending));

            if (route) {
                yield* route[1](turn);

                return;
            }

            yield { type: 'session', sessionId: `s-${ turn.number }` };
            yield { type: 'done', result: 'Done' };
        });
        const h = await startHarness({}, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const { store, runs, threads } = h.daemon.services;
        const chatOf = (chatId: string) => getChat(store.db, chatId) as Chat;
        const runOf = (chatId: string) => h.run(chatOf(chatId).orchestratorRunId as string);
        const on = (ending: string, script: Script) => routes.push([ending, script]);
        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };

        on('Plan the release', held(latch()));
        h.ok('chat.send', { chatId: chat.id, text: 'Plan the release' });
        await waitFor(() => chatOf(chat.id).orchestratorRunId && runOf(chat.id).status === 'running', 'the parent to run');

        const parent = runOf(chat.id);
        const bridge = new ToolBridge();

        bridges.push(bridge);

        const tools = toolsFor({ store, runs, threads }, parent, runs.modeOf(parent));
        const access = bridge.register(tools, new AbortController().signal);
        const shimDir = join(h.config.dataDir, 'bin');
        const env = { PATH: `${ shimDir }${ delimiter }${ process.env.PATH }`, CLOWDY_CLI_URL: access.cli?.url, CLOWDY_CLI_AUTH: access.cli?.auth };
        /** Runs `script` as the agent's shell would, in the project's folder. */
        const shell = (script: string, options: { env?: Record<string, string | undefined>; stdin?: string | 'ignore' | 'open' } = {}) => run(['sh', '-c', script], { cwd: project.path, ...options, env: { ...env, ...options.env } });
        const json = async (script: string) => {
            const ran = await shell(script);

            expect({ script, code: ran.code, stderr: ran.stderr }).toEqual({ script, code: 0, stderr: '' });

            return JSON.parse(ran.stdout);
        };

        return { h, engine, store, chat: chatOf(chat.id), tools, access, chatOf, runOf, on, shell, json };
    }

    test('spawns a thread from a heredoc, then lists, tells, reads, waits for and stops it', async () => {
        const { h, store, chat, chatOf, runOf, on, shell, json } = await setup();
        const brief = 'Look into the slow cache.\nIt\'s "slow"; $HOME and `date` stay as written.\nReport what you find';

        on('Report what you find', held(latch()));

        const spawned = await json(`clowdy thread spawn --title 'Cache check' --prompt-file - <<'EOF'\n${ brief }\nEOF`);

        const thread = spawned.threadId as string;

        expect(thread).toMatch(/^cht_/);
        expect(spawned).toMatchObject({ title: 'Cache check', state: 'working' });

        expect(chatOf(thread)).toMatchObject({ parentChatId: chat.id, title: 'Cache check' });
        await waitFor(() => runOf(thread).status === 'running', 'the thread to run');
        // The brief arrives exactly as written, without the line break the heredoc ends with.
        expect(listItems(store.db, runOf(thread).id, 0)[0].body).toEqual({ kind: 'user', text: brief, from: { kind: 'thread', chatId: chat.id, title: chat.title } });

        const listed = await json('clowdy thread list --json');

        expect(listed).toMatchObject({ ok: true, result: { threads: [{ threadId: thread, title: 'Cache check', state: 'working' }] } });

        // The thread is busy and its agent takes no steer, so the message waits for its next turn.
        expect(await json(`clowdy thread tell ${ thread } Also check the TTL, please`)).toEqual({ delivery: 'queued' });
        expect(chatOf(thread).queue?.map(item => item.text)).toEqual(['Also check the TTL, please']);

        expect(await json(`clowdy thread output ${ thread }`)).toMatchObject({ threadId: thread, state: 'working', text: 'working' });
        expect((await json(`clowdy thread log ${ thread } --limit 5`)).lines.join('\n')).toContain('working');
        expect(await json(`clowdy thread wait ${ thread } --timeout-seconds 1`)).toMatchObject({ state: 'working', timedOut: true });

        expect(await json(`clowdy thread stop ${ thread }`)).toEqual({ stopped: true, state: 'stopped' });
        expect(runOf(thread).status).toBe('cancelled');
        expect(await json(`clowdy thread wait ${ thread }`)).toMatchObject({ state: 'stopped', timedOut: false });
        expect(h.run(runOf(chat.id).id).status).toBe('running');
    });

    test('a wait blocks until the thread rests and answers with its report', async () => {
        const { runOf, on, shell, json } = await setup();
        const gate = latch();

        on('Count the tests', held(gate, 'There are 41 tests'));

        const { threadId } = await json('clowdy thread spawn --prompt "Count the tests"');

        await waitFor(() => runOf(threadId).status === 'running', 'the thread to run');

        const waiting = shell(`clowdy thread wait ${ threadId } --timeout-seconds 30 --json`);

        await Bun.sleep(300);
        gate.release();

        const ran = await waiting;

        expect(ran.code).toBe(0);
        expect(JSON.parse(ran.stdout)).toMatchObject({ ok: true, result: { threadId, state: 'idle', text: 'There are 41 tests', timedOut: false } });
    });

    test('creates tasks from a heredoc, lists the work in flight, and changes a task with options', async () => {
        const { shell, json } = await setup();
        const description = 'Outcome: it exports.\nIt\'s "quoted"; $HOME and `date` stay as written.\nCheck: the page';

        const first = await json(`clowdy task create CSV export --description-file - <<'EOF'\n${ description }\nEOF`);

        expect(first.task).toMatchObject({ key: 'REP-1', title: 'CSV export', description, status: 'To do', createdBy: 'agent' });
        expect((await json('clowdy task create "Document it" --depends-on REP-1 --status todo')).task).toMatchObject({ key: 'REP-2', dependsOn: [{ key: 'REP-1', title: 'CSV export', status: 'To do' }] });

        const open = await json('clowdy task list');

        expect(open.tasks.map((row: { key: string }) => row.key).sort()).toEqual(['REP-1', 'REP-2']);
        expect(open.tasks.find((row: { key: string }) => row.key === 'REP-2')).toMatchObject({ blockedBy: ['REP-1'] });
        expect(open).toMatchObject({ total: 2, counts: { todo: 2, done: 0 } });
        expect(open.statuses.map((status: { name: string }) => status.name)).toContain('Done');

        expect((await json('clowdy task update REP-1 --status done')).task).toMatchObject({ category: 'done' });
        expect((await json('clowdy task list')).tasks.map((row: { key: string }) => row.key)).toEqual(['REP-2']);
        expect((await json('clowdy task list --status done --json')).result).toMatchObject({ total: 1, tasks: [{ key: 'REP-1' }] });
        expect((await json('clowdy task list --ready')).tasks.map((row: { key: string }) => row.key)).toEqual(['REP-2']);
        expect((await json('clowdy task list --query export')).tasks.map((row: { key: string }) => row.key)).toEqual(['REP-1']);
        expect((await json('clowdy task list --all --limit 1 --sort number')).nextCursor).toBeDefined();

        const appended = await json('clowdy task update REP-2 --append "Verification passed: 41 tests" --add-depends-on REP-1');

        expect(appended.task.description).toBe('Verification passed: 41 tests');
        expect((await json('clowdy task get REP-1')).task).toMatchObject({ description, blocks: [{ key: 'REP-2', title: 'Document it' }] });

        // The removed statusId option is a usage error that lists the options.
        const old = await shell('clowdy task update REP-2 --status-id done');

        expect(old.code).toBe(2);
        expect(old.stderr).toContain('Unknown option --status-id');
        expect(old.stderr).toContain('--status');
        expect((await shell('clowdy task get REP-99')).code).toBe(1);
    });

    test('a refused call exits 1 with the daemon\'s message, a bad command line 2, and stdin with nothing in it 2 without hanging', async () => {
        const { chat, shell } = await setup();

        const refused = await shell(`clowdy thread stop ${ chat.id }`);

        expect(refused.code).toBe(1);
        expect(refused.stdout).toBe('');
        expect(refused.stderr).toContain('is not below you');

        const missing = await shell('clowdy thread spawn --title "No brief"');

        expect(missing.code).toBe(2);
        expect(missing.stderr).toContain('Missing --prompt');

        const unknown = await shell('clowdy thread fork cht_1');

        expect(unknown.code).toBe(2);
        expect(unknown.stderr).toContain('Unknown command "thread fork"');

        const empty = await shell('clowdy thread spawn --prompt-file -', { stdin: 'ignore' });

        expect(empty.code).toBe(2);
        expect(empty.stderr).toContain('stdin was empty');

        const silent = await shell('clowdy thread spawn --prompt-file -', { stdin: 'open', env: { CLOWDY_CLI_STDIN_IDLE_MS: '300' } });

        expect(silent.code).toBe(2);
        expect(silent.stderr).toContain('Nothing came on stdin');
    });

    test('a wrong credential and a session that ended exit 4', async () => {
        const { access, shell } = await setup();

        const wrong = await shell('clowdy thread list', { env: { CLOWDY_CLI_AUTH: 'not-the-credential' } });

        expect(wrong.code).toBe(4);
        expect(wrong.stderr).toContain('no longer valid');

        const outside = await shell('clowdy thread list', { env: { CLOWDY_CLI_URL: undefined, CLOWDY_CLI_AUTH: undefined } });

        expect(outside.code).toBe(4);
        expect(outside.stderr).toContain('inside an agent session');

        access.dispose();

        const ended = await shell('clowdy thread list --json');

        expect(ended.code).toBe(4);
        expect(JSON.parse(ended.stdout)).toMatchObject({ ok: false, error: { code: 'unreachable' } });
    });

    test('the help\'s examples use only commands and options the task and thread tools have', async () => {
        const { tools } = await setup();
        const commands = new Map(tools.filter(candidate => candidate.cli).map(candidate => [candidate.name, candidate as unknown as CliTool]));

        expect([...commands.keys()].sort()).toEqual(['task_create', 'task_get', 'task_list', 'task_update', 'thread_list', 'thread_log', 'thread_output', 'thread_spawn', 'thread_stop', 'thread_tell', 'thread_wait']);

        for (const [name, lines] of Object.entries(EXAMPLES)) {
            const known = commands.get(name);

            expect({ name, known: Boolean(known) }).toEqual({ name, known: true });

            for (const line of lines.filter(candidate => candidate.startsWith('clowdy '))) {
                expect(line.startsWith(`clowdy ${ name.replace('_', ' ') } `)).toBe(true);

                const flags = [...line.split('#')[0].matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map(match => match[1]);

                expect({ line, unknown: flags.filter(flag => !['json', 'help', ...flagsOf(known as CliTool)].includes(flag)) }).toEqual({ line, unknown: [] });
            }
        }
    });
});

describe('the agent process of a session with shell commands', () => {
    let shim: Shim;

    /** What the fake agent said for each line of its prompt, one message per directive. */
    async function session(prompt: string, tools: ToolDefinition[], options: Parameters<typeof rig>[0] = {}, registered: ReturnType<ToolBridge['register']>[] = []) {
        shim ??= installShim(tempDir());

        const r = rig({ shim, env: { PATH: process.env.PATH, HOME: process.env.HOME, CLOWDY_CLI_URL: 'http://stale.example', CLOWDY_CLI_AUTH: 'stale' }, ...options });
        const register = r.bridge.register.bind(r.bridge);

        r.bridge.register = (...args) => {
            const access = register(...args);

            registered.push(access);

            return access;
        };

        const { session: started } = r.start(prompt, { tools });
        const events = await collect(started);

        await started.close();
        bridges.push(r.bridge);

        return { events, registered };
    }

    const listing = command('thread_list', async () => ({ threads: ['cht_1'] }));
    const plain = tool('task_list', async () => 'tasks');

    test('has the command first on its PATH, the credential that works while the session lives, and no CLI tool among its MCP tools', async () => {
        const { events, registered } = await session([
            'env CLOWDY_CLI_URL',
            'env CLOWDY_CLI_AUTH',
            'env CLOWDY_CLI',
            'env PATH',
            'shell clowdy thread list',
            'shell PATH=/usr/bin:/bin; "$CLOWDY_CLI" thread list --json',
            'tools',
        ].join('\n'), [plain, listing]);
        const text = textOf(events);
        const [access] = registered;

        expect(registered).toHaveLength(1);
        expect(text).toContain(`CLOWDY_CLI_URL=${ access.cli?.url }`);
        expect(text).toContain(`CLOWDY_CLI_AUTH=${ access.cli?.auth }`);
        expect(text).toContain(`CLOWDY_CLI=${ shim.command }`);
        expect(text).toContain(`PATH=${ shim.dir }${ delimiter }`);
        expect(text).toContain(JSON.stringify({ code: 0, stdout: '{"threads":["cht_1"]}\n', stderr: '' }));
        // A shell whose PATH lost the command still has it by its absolute path.
        expect(text).toContain(JSON.stringify({ code: 0, stdout: '{"ok":true,"result":{"threads":["cht_1"]}}\n', stderr: '' }));
        expect(text).toContain('["task_list"]');

        // The session is over: its credential with it.
        expect((await fetch(`${ access.cli?.url }/cli/tools`, { headers: { authorization: `Bearer ${ access.cli?.auth }` } })).status).toBe(401);
    });

    test('without shell commands gets none of the variables, and the daemon\'s own are never passed on', async () => {
        for (const tools of [[plain], []]) {
            const { events } = await session('env CLOWDY_CLI_URL\nenv CLOWDY_CLI_AUTH\nenv CLOWDY_CLI\nenv PATH', tools);
            const text = textOf(events);

            expect(text).toContain('CLOWDY_CLI_URL=CLOWDY_CLI_AUTH=CLOWDY_CLI=PATH=');
            expect(text).not.toContain(shim.dir);
        }
    });

    test.each(PROTOCOLS)('over %s, a session of shell commands only names no MCP server', async (protocol) => {
        const { events } = await session('info', [listing], { protocol });

        expect(JSON.parse(textOf(events))).toMatchObject({ servers: [] });
    });

    test('an agent started again on another protocol gets a new credential, and the first one stops working', async () => {
        let first: number | undefined;
        const registered: ReturnType<ToolBridge['register']>[] = [];
        const probe = command('thread_list', async () => {
            first = (await fetch(`${ registered[0].cli?.url }/cli/tools`, { headers: { authorization: `Bearer ${ registered[0].cli?.auth }` } })).status;

            return 'listed';
        });
        // The v1 fake agent asked for v2 answers with version 1, so the engine starts it again on v1.
        const { events } = await session('env CLOWDY_CLI_AUTH\nshell clowdy thread list', [probe], { protocol: 'v2', args: [FAKE_AGENT] }, registered);

        expect(registered).toHaveLength(2);
        expect(textOf(events)).toContain(`CLOWDY_CLI_AUTH=${ registered[1].cli?.auth }`);
        expect(textOf(events)).toContain('"stdout":"listed\\n"');
        expect(first).toBe(401);
    });
});
