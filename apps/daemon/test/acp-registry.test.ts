import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KNOWN_AGENTS } from '../src/engine/acp/catalog';
import { Discovery, parseVersion, readLoginPath } from '../src/engine/acp/discovery';
import { buildAgentEnv } from '../src/engine/acp/env';
import { AgentRegistry, AgentRegistryError } from '../src/engine/acp/registry';

let root: string;
let bin: string;

/** The package an adapter agent is fetched as, from the catalog, so a new pin touches no test. */
function pinned(id: string): string {
    const launch = KNOWN_AGENTS.find(agent => agent.id === id)?.launch;

    if (launch?.kind !== 'package') throw new Error(`${ id } is not run from a package`);

    return launch.package;
}

/** An executable that prints `output` when run. */
function program(name: string, output: string): string {
    const path = join(bin, name);

    writeFileSync(path, `#!/bin/sh\necho "${ output }"\n`);
    chmodSync(path, 0o755);

    return path;
}

const discovery = () => new Discovery({ env: { PATH: bin }, home: join(root, 'home'), loginPath: async () => undefined, installDirs: [] });

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clowdy-agents-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'home'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the catalog', () => {
    test('fetches each adapter at one exact, stable version, never a range, a tag or a preview', () => {
        const packages = KNOWN_AGENTS.flatMap(agent => agent.launch.kind === 'package' ? [agent.launch.package] : []);

        expect(packages.length).toBeGreaterThan(0);

        for (const name of packages) {
            expect(name).toMatch(/^@[a-z0-9-]+\/[a-z0-9-]+@\d+\.\d+\.\d+$/);
        }
    });
});

describe('buildAgentEnv', () => {
    test('passes the user\'s environment, drops the daemon\'s secrets and the agent\'s provider keys, and sets the path', () => {
        const env = buildAgentEnv({
            daemonEnv: { HOME: '/h', PATH: '/bare', CLOWDY_TOKEN: 't', CLOWDY_CLAUDE_API_KEY: 'k', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk', HTTPS_PROXY: 'p', CODEX_HOME: '/c' },
            path: '/login:/bare',
            scrub: [/^ANTHROPIC_API_KEY$/],
            set: { CLAUDE_CODE_EXECUTABLE: '/usr/bin/claude' },
        });

        expect(env).toEqual({ HOME: '/h', HTTPS_PROXY: 'p', CODEX_HOME: '/c', PATH: '/login:/bare', CLAUDE_CODE_EXECUTABLE: '/usr/bin/claude' });
    });

    test('a path variable spelled another way does not survive next to the real one', () => {
        expect(buildAgentEnv({ daemonEnv: { Path: 'C:\\bare' }, path: 'C:\\found' })).toEqual({ PATH: 'C:\\found' });
    });
});

describe('Discovery', () => {
    test('finds a program on the search path, and the first of several names', async () => {
        const path = program('cursor-agent', 'x');

        expect(await discovery().find(['agent', 'cursor-agent'])).toEqual({ path, name: 'cursor-agent' });
        expect(await discovery().find(['nope'])).toBeUndefined();
    });

    test('searches the login shell\'s path and the usual install folders too', async () => {
        const login = join(root, 'login');
        const local = join(root, 'home', '.local', 'bin');

        mkdirSync(login);
        mkdirSync(local, { recursive: true });
        writeFileSync(join(login, 'viashell'), '#!/bin/sh\n', { mode: 0o755 });
        writeFileSync(join(local, 'inlocal'), '#!/bin/sh\n', { mode: 0o755 });

        const found = new Discovery({ env: { PATH: '/nowhere' }, home: join(root, 'home'), loginPath: async () => login, installDirs: [local] });

        expect((await found.find(['viashell']))?.path).toBe(join(login, 'viashell'));
        expect((await found.find(['inlocal']))?.path).toBe(join(local, 'inlocal'));
        expect((await found.dirs()).slice(0, 2)).toEqual([login, '/nowhere']);
    });

    test('the login shell is read for its PATH, and a shell that leaves a process holding its output is not waited for', async () => {
        const shell = join(bin, 'shell');

        // Prints its PATH, then leaves a background process that keeps the output pipe open for a while.
        writeFileSync(shell, '#!/bin/sh\necho "noise from a startup file"\nprintf \'__CLOWDY_PATH__/login/bin:/usr/bin__CLOWDY_PATH__\'\n(sleep 6 >&1 &)\n');
        chmodSync(shell, 0o755);

        const started = Date.now();

        // The deadline is generous: the first run of a script that was just written can be slow on macOS. What matters
        // is that the 6 second background process is not waited for.
        expect(await readLoginPath({ SHELL: shell, PATH: '/usr/bin:/bin' }, 2000)).toBe('/login/bin:/usr/bin');
        expect(Date.now() - started).toBeLessThan(5000);
        expect(await readLoginPath({ SHELL: join(bin, 'no-such-shell') }, 2000)).toBeUndefined();
    });

    test('reads a version from what the program prints', async () => {
        const path = program('claude', '2.1.325 (Claude Code)');

        expect(await discovery().version(path)).toBe('2.1.325');
        expect(await discovery().version(join(bin, 'missing'))).toBeUndefined();
    });

    test('a program asked for its version does not see the daemon\'s secrets', async () => {
        const path = join(bin, 'tell');

        writeFileSync(path, '#!/bin/sh\necho "token=${CLOWDY_TOKEN:-none}"\n');
        chmodSync(path, 0o755);

        const probing = new Discovery({ env: { PATH: bin, CLOWDY_TOKEN: 'secret' }, home: join(root, 'home'), loginPath: async () => undefined, installDirs: [] });

        expect(await probing.version(path)).toBe('token=none');
    });

    test.each([['2.1.325 (Claude Code)', '2.1.325'], ['codex-cli 0.166.0', '0.166.0'], ['2026.09.01-abcdef', '2026.09.01-abcdef'], ['v1.2.3-beta.1', '1.2.3-beta.1'], ['hello', 'hello'], ['', undefined]])('parseVersion(%j) is %j', (output, version) => {
        expect(parseVersion(output)).toBe(version);
    });
});

describe('AgentRegistry', () => {
    const registry = (dataDir?: string) => new AgentRegistry({ discovery: discovery(), dataDir });
    const byId = async (reg: AgentRegistry, id: string) => (await reg.list()).find(info => info.id === id);

    test('an installed native agent is ready with its version and launch line; one that is not is missing and says so', async () => {
        const path = program('cursor-agent', 'cursor 2026.09.01');
        const reg = registry();

        expect(await byId(reg, 'cursor')).toEqual({ id: 'cursor', name: 'Cursor', custom: false, enabled: true, status: 'ready', path, version: '2026.09.01', launch: 'cursor-agent acp', login: 'cursor-agent login' });
        expect(await byId(reg, 'opencode')).toMatchObject({ status: 'missing', detail: expect.stringContaining('no `opencode` command was found'), launch: 'opencode acp' });
    });

    test('Claude Code starts through its official adapter on the user\'s own claude, with the cautions of its profile', async () => {
        const claude = program('claude', '2.1.325 (Claude Code)');
        const reg = registry();

        expect(await byId(reg, 'claude')).toEqual({ id: 'claude', name: 'Claude Code', custom: false, enabled: true, status: 'ready', path: claude, version: '2.1.325', launch: `bun x --bun ${ pinned('claude') }`, fetches: pinned('claude'), login: 'claude auth login', settings: expect.any(Array) });

        const resolved = await reg.resolve('claude');

        expect(resolved).toMatchObject({ ok: true, agent: { command: process.execPath, args: ['x', '--bun', pinned('claude')] } });
        expect(resolved.ok && resolved.agent.env).toMatchObject({ CLAUDE_CODE_EXECUTABLE: claude, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
        expect(resolved.ok && resolved.agent.scrub.some(pattern => pattern.test('ANTHROPIC_API_KEY'))).toBe(true);
        expect(resolved.ok && resolved.agent.sessionMeta).toEqual({ claudeCode: { options: { disallowedTools: ['AskUserQuestion', 'ExitPlanMode'] } } });
    });

    describe('settings', () => {
        const settingsOf = async (reg: AgentRegistry) => Object.fromEntries(((await byId(reg, 'claude'))?.settings ?? []).map(setting => [setting.id, setting.value]));
        const start = async (reg: AgentRegistry) => {
            const resolved = await reg.resolve('claude');

            if (!resolved.ok) {
                throw new Error(resolved.message);
            }

            return resolved.agent;
        };

        test('Claude Code lists its settings at their defaults, and the defaults are what a run gets today', async () => {
            program('claude', '2.1.325 (Claude Code)');

            const reg = registry();

            expect(await settingsOf(reg)).toEqual({ memory: false, connectors: false, subagents: true, longContext: true });
            expect((await byId(reg, 'claude'))?.settings?.[0]).toMatchObject({ id: 'memory', default: false, label: expect.any(String), description: expect.any(String) });

            const agent = await start(reg);

            expect(agent.env).toMatchObject({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
            expect(agent.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_1M_CONTEXT');
            expect(agent.sessionMeta).toEqual({ claudeCode: { options: { disallowedTools: ['AskUserQuestion', 'ExitPlanMode'] } } });
        });

        test('a setting turned on or off changes the environment and the tools the agent starts with', async () => {
            program('claude', '2.1.325 (Claude Code)');

            const reg = registry();

            reg.update('claude', { settings: { memory: true, connectors: true, subagents: false, longContext: false } });

            expect(await settingsOf(reg)).toEqual({ memory: true, connectors: true, subagents: false, longContext: false });

            const agent = await start(reg);

            expect(agent.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
            expect(agent.env).not.toHaveProperty('ENABLE_CLAUDEAI_MCP_SERVERS');
            expect(agent.env).toMatchObject({ CLAUDE_CODE_DISABLE_1M_CONTEXT: '1', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3' });
            expect(agent.sessionMeta).toEqual({ claudeCode: { options: { disallowedTools: ['AskUserQuestion', 'ExitPlanMode', 'Agent', 'Task', 'ListAgents'] } } });

            // A change names only what it changes.
            reg.update('claude', { settings: { memory: false } });

            expect(await settingsOf(reg)).toEqual({ memory: false, connectors: true, subagents: false, longContext: false });
        });

        test('are kept in agents.json, refuse a setting the agent does not have, and give way to the variables the person set', async () => {
            program('claude', '2.1.325 (Claude Code)');

            const dir = mkdtempSync(join(root, 'data-'));
            const reg = registry(dir);

            reg.update('claude', { settings: { memory: true }, env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'true' } });

            expect(() => reg.update('claude', { settings: { nothing: true } })).toThrow('no setting called');
            expect(() => reg.update('cursor', { settings: { memory: true } })).toThrow('no setting called');
            expect(await settingsOf(registry(dir))).toMatchObject({ memory: true });
            expect((await start(registry(dir))).env).toMatchObject({ ENABLE_CLAUDEAI_MCP_SERVERS: 'true' });
            expect((await byId(registry(dir), 'claude'))?.overrides).toEqual({ env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'true' } });
            expect((await byId(reg, 'cursor'))?.settings).toBeUndefined();
        });
    });

    test('an adapter agent needs its program and a Bun to fetch the adapter; both are named when one is missing', async () => {
        const codex = program('codex', 'codex-cli 0.166.0');
        let bun: string | undefined;
        const reg = new AgentRegistry({ discovery: discovery(), runtime: async () => bun });

        expect(await byId(reg, 'codex')).toMatchObject({ status: 'needs-runtime', path: codex, detail: expect.stringContaining('bun x'), fetches: pinned('codex') });

        bun = program('bun', '1.4.0');
        reg.refresh();

        expect(await byId(reg, 'codex')).toMatchObject({ status: 'ready', version: '0.166.0' });
        expect(await byId(reg, 'claude')).toMatchObject({ status: 'missing' });
    });

    test('an adapter starts through the daemon\'s own Bun (`bun x --bun`) with the user\'s own program, and without optional dependencies', async () => {
        const codex = program('codex', 'x');
        const resolved = await registry().resolve('codex');

        expect(resolved).toMatchObject({ ok: true, agent: { command: process.execPath, args: ['x', '--bun', pinned('codex')] } });
        expect(resolved.ok && resolved.agent.env).toMatchObject({ CODEX_PATH: codex, npm_config_omit: 'optional' });
        expect(resolved.ok && resolved.agent.scrub.some(pattern => pattern.test('OPENAI_API_KEY'))).toBe(true);
    });

    test('a path the user chose replaces the search, and a switch turns an agent off', async () => {
        const chosen = program('my-opencode', 'x');
        const reg = registry();

        reg.update('opencode', { path: chosen });
        expect(await reg.resolve('opencode')).toMatchObject({ ok: true, agent: { command: chosen, args: ['acp'] } });

        reg.update('opencode', { enabled: false });
        expect(await byId(reg, 'opencode')).toMatchObject({ status: 'disabled', enabled: false });
        expect(await reg.resolve('opencode')).toEqual({ ok: false, message: 'OpenCode is switched off in Clowdy' });
    });

    test('a custom agent is any command, kept in agents.json across restarts', async () => {
        const dataDir = join(root, 'data');
        const tool = program('my-agent', '3.0');
        const reg = registry(dataDir);

        reg.add({ id: 'mine', name: 'Mine', command: 'my-agent', args: ['--acp'], env: { A: '1' } });
        reg.update('mine', { env: { B: '2' } });

        expect(await byId(reg, 'mine')).toMatchObject({ custom: true, status: 'ready', path: tool, version: '3.0', launch: 'my-agent --acp' });
        expect(await reg.resolve('mine')).toMatchObject({ ok: true, agent: { command: tool, args: ['--acp'], env: { A: '1', B: '2' } } });
        expect(reg.has('mine')).toBe(true);

        const again = registry(dataDir);

        expect(again.has('mine')).toBe(true);
        expect(await again.resolve('mine')).toMatchObject({ ok: true });

        again.remove('mine');

        expect(registry(dataDir).has('mine')).toBe(false);
        expect(JSON.parse(readFileSync(join(dataDir, 'agents.json'), 'utf8'))).toEqual({ agents: [], overrides: {} });
    });

    test('adding checks the id and refuses a clash with a built-in agent, fake, or an earlier one', () => {
        const reg = registry();
        const agent = { name: 'X', command: 'x', args: [] };

        expect(() => reg.add({ ...agent, id: 'Bad Id' })).toThrow(AgentRegistryError);
        expect(() => reg.add({ ...agent, id: 'claude' })).toThrow(/already exists/);
        expect(() => reg.add({ ...agent, id: 'fake' })).toThrow(/already exists/);
        expect(() => reg.add({ ...agent, id: 'ok', command: ' ' })).toThrow(/name and a command/);

        reg.add({ ...agent, id: 'ok' });

        expect(() => reg.add({ ...agent, id: 'ok' })).toThrow(/already exists/);
        expect(() => reg.remove('claude')).toThrow(/built in/);
        expect(() => reg.remove('nobody')).toThrow(/no custom agent/);
        expect(() => reg.update('nobody', { enabled: false })).toThrow(/no agent/);
    });

    test('a damaged agents.json is ignored, with a warning, and does not stop the daemon', async () => {
        const dataDir = join(root, 'data');

        mkdirSync(dataDir);
        writeFileSync(join(dataDir, 'agents.json'), '{ nope');

        const warn = console.warn;
        const warnings: string[] = [];

        console.warn = (message: string) => void warnings.push(message);

        try {
            expect(registry(dataDir).has('claude')).toBe(true);
        }
        finally {
            console.warn = warn;
        }

        expect(warnings[0]).toContain('could not be read');
    });

    test('a change names what it changes: the rest of the agent\'s settings stay, even when the caller passes them as undefined', async () => {
        const chosen = program('my-opencode', 'x');
        const reg = registry();

        reg.update('opencode', { enabled: false, env: { KEY: 'v' } });
        reg.update('opencode', { enabled: undefined, env: undefined, path: chosen });

        expect(await byId(reg, 'opencode')).toMatchObject({ status: 'disabled', path: chosen });

        reg.update('opencode', { enabled: true });

        expect(await reg.resolve('opencode')).toMatchObject({ ok: true, agent: { command: chosen, env: { KEY: 'v' } } });
    });

    test('a program is a name or an absolute path: a relative one would be read against the wrong folder', () => {
        const reg = registry();

        expect(() => reg.add({ id: 'rel', name: 'Rel', command: './agent', args: [] })).toThrow(/program name or an absolute path/);
        expect(() => reg.update('opencode', { path: 'bin/opencode' })).toThrow(/must be absolute/);

        reg.add({ id: 'abs', name: 'Abs', command: '/usr/bin/agent', args: [] });

        expect(() => reg.update('abs', { command: '../agent' })).toThrow(/program name or an absolute path/);
        expect(reg.has('rel')).toBe(false);
    });

    test('a variable set for Claude Code replaces its default, and is how an API key reaches it', async () => {
        program('claude', 'x');

        const reg = registry();

        reg.update('claude', { env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'true', ANTHROPIC_API_KEY: 'k' } });

        const resolved = await reg.resolve('claude');

        expect(resolved.ok && resolved.agent.env).toMatchObject({ ENABLE_CLAUDEAI_MCP_SERVERS: 'true', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    });

    test('agents.json keeps what is usable of a damaged file, and what is written is private to the user', () => {
        const dataDir = join(root, 'data');

        mkdirSync(dataDir);
        writeFileSync(join(dataDir, 'agents.json'), JSON.stringify({
            agents: [null, 7, { id: 'good', command: ' tool ', args: ['a', 1], env: { A: '1' } }, { id: 'claude', command: 'x' }, { id: 'fake', command: 'x' }, { id: 'Bad Id', command: 'x' }, { id: 'nocommand' }, { id: 'twice', command: 'first' }, { id: 'twice', command: 'second' }, { id: 'badenv', command: 'x', env: { A: 1 } }],
            overrides: { cursor: { enabled: 'no', path: 5, env: { A: 1 } }, opencode: { enabled: false, path: '/x/opencode', env: { K: 'v' } }, gemini: 7 },
        }));

        const reg = registry(dataDir);

        reg.update('good', { name: 'Good one' });

        const saved = JSON.parse(readFileSync(join(dataDir, 'agents.json'), 'utf8'));

        expect(saved.agents).toEqual([
            { id: 'good', name: 'Good one', command: 'tool', args: ['a', '1'], env: { A: '1' } },
            { id: 'twice', name: 'twice', command: 'first', args: [] },
            { id: 'badenv', name: 'badenv', command: 'x', args: [] },
        ]);
        expect(saved.overrides).toEqual({ cursor: {}, good: {}, opencode: { enabled: false, path: '/x/opencode', env: { K: 'v' } } });
        expect(statSync(join(dataDir, 'agents.json')).mode & 0o777).toBe(0o600);
    });

    test('a change that cannot be written is not kept either', async () => {
        const dataDir = join(root, 'data');

        // A folder where the file belongs: the write fails.
        mkdirSync(join(dataDir, 'agents.json'), { recursive: true });

        const warn = console.warn;

        console.warn = () => undefined;

        const reg = registry(dataDir);

        console.warn = warn;

        expect(() => reg.add({ id: 'lost', name: 'Lost', command: 'x', args: [] })).toThrow();
        expect(() => reg.update('opencode', { enabled: false })).toThrow();
        expect(reg.has('lost')).toBe(false);
        expect(await byId(reg, 'opencode')).toMatchObject({ enabled: true });
    });

    test('results are reused for a short while', async () => {
        let now = 0;
        const reg = new AgentRegistry({ discovery: discovery(), now: () => now });
        const first = reg.list();

        now = 10_000;
        expect(reg.list()).toBe(first);
        now = 31_000;
        expect(reg.list()).not.toBe(first);
    });
});
