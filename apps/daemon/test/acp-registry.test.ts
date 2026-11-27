import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Discovery, parseVersion, readLoginPath } from '../src/engine/acp/discovery';
import { buildAgentEnv } from '../src/engine/acp/env';
import { AgentRegistry, AgentRegistryError } from '../src/engine/acp/registry';
import { PROVIDERS } from '../src/providers/builtin';

import type { AgentPermissions } from '@clowdy/protocol';

const SPECS = PROVIDERS.map(provider => provider.spec);

/** What `AgentInfo.permissions` says for an agent whose provider declares none: the client's pair, `full` by default. */
const GENERIC_PERMISSIONS: AgentPermissions = {
    presets: [
        { id: 'ask', name: 'Ask for approval', description: expect.any(String) },
        { id: 'full', name: 'Full access', description: expect.any(String) },
    ],
    default: 'full',
};

let root: string;
let bin: string;

/** The package an adapter agent is fetched as, from the catalog, so a new pin touches no test. */
function pinned(id: string): string {
    const launch = SPECS.find(agent => agent.id === id)?.launch;

    if (launch?.kind !== 'package') throw new Error(`${id} is not run from a package`);

    return launch.package;
}

/** An executable that prints `output` when run. */
function program(name: string, output: string): string {
    const path = join(bin, name);

    writeFileSync(path, `#!/bin/sh\necho "${output}"\n`);
    chmodSync(path, 0o755);

    return path;
}

const discovery = () =>
    new Discovery({ env: { PATH: bin }, home: join(root, 'home'), loginPath: async () => undefined, installDirs: [] });

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clowdy-agents-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'home'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the catalog', () => {
    test('fetches each adapter at one exact, stable version, never a range, a tag or a preview', () => {
        const packages = SPECS.flatMap(agent => (agent.launch.kind === 'package' ? [agent.launch.package] : []));

        expect(packages.length).toBeGreaterThan(0);

        for (const name of packages) {
            expect(name).toMatch(/^@[a-z0-9-]+\/[a-z0-9-]+@\d+\.\d+\.\d+$/);
        }
    });
});

describe('buildAgentEnv', () => {
    test("passes the user's environment, drops the daemon's secrets and the agent's provider keys, and sets the path", () => {
        const env = buildAgentEnv({
            daemonEnv: {
                HOME: '/h',
                PATH: '/bare',
                CLOWDY_TOKEN: 't',
                CLOWDY_CLAUDE_API_KEY: 'k',
                ELECTRON_RUN_AS_NODE: '1',
                NODE_OPTIONS: '--x',
                CLAUDECODE: '1',
                ANTHROPIC_API_KEY: 'sk',
                HTTPS_PROXY: 'p',
                CODEX_HOME: '/c',
            },
            path: '/login:/bare',
            scrub: [/^ANTHROPIC_API_KEY$/],
            set: { CLAUDE_CODE_EXECUTABLE: '/usr/bin/claude' },
        });

        expect(env).toEqual({
            HOME: '/h',
            HTTPS_PROXY: 'p',
            CODEX_HOME: '/c',
            PATH: '/login:/bare',
            CLAUDE_CODE_EXECUTABLE: '/usr/bin/claude',
        });
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

    test("searches the login shell's path and the usual install folders too", async () => {
        const login = join(root, 'login');
        const local = join(root, 'home', '.local', 'bin');

        mkdirSync(login);
        mkdirSync(local, { recursive: true });
        writeFileSync(join(login, 'viashell'), '#!/bin/sh\n', { mode: 0o755 });
        writeFileSync(join(local, 'inlocal'), '#!/bin/sh\n', { mode: 0o755 });

        const found = new Discovery({
            env: { PATH: '/nowhere' },
            home: join(root, 'home'),
            loginPath: async () => login,
            installDirs: [local],
        });

        expect((await found.find(['viashell']))?.path).toBe(join(login, 'viashell'));
        expect((await found.find(['inlocal']))?.path).toBe(join(local, 'inlocal'));
        expect((await found.dirs()).slice(0, 2)).toEqual([login, '/nowhere']);
    });

    test('the login shell is read for its PATH, and a shell that leaves a process holding its output is not waited for', async () => {
        const shell = join(bin, 'shell');

        // Prints its PATH, then leaves a background process that keeps the output pipe open for a while.
        writeFileSync(
            shell,
            '#!/bin/sh\necho "noise from a startup file"\nprintf \'__CLOWDY_PATH__/login/bin:/usr/bin__CLOWDY_PATH__\'\n(sleep 6 >&1 &)\n'
        );
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

    test("a program asked for its version does not see the daemon's secrets", async () => {
        const path = join(bin, 'tell');

        writeFileSync(path, '#!/bin/sh\necho "token=${CLOWDY_TOKEN:-none}"\n');
        chmodSync(path, 0o755);

        const probing = new Discovery({
            env: { PATH: bin, CLOWDY_TOKEN: 'secret' },
            home: join(root, 'home'),
            loginPath: async () => undefined,
            installDirs: [],
        });

        expect(await probing.version(path)).toBe('token=none');
    });

    test.each([
        ['2.1.325 (Claude Code)', '2.1.325'],
        ['codex-cli 0.166.0', '0.166.0'],
        ['2026.09.01-abcdef', '2026.09.01-abcdef'],
        ['v1.2.3-beta.1', '1.2.3-beta.1'],
        ['hello', 'hello'],
        ['', undefined],
    ])('parseVersion(%j) is %j', (output, version) => {
        expect(parseVersion(output)).toBe(version);
    });
});

describe('AgentRegistry', () => {
    const registry = (dataDir?: string, platform?: NodeJS.Platform) =>
        new AgentRegistry({ discovery: discovery(), dataDir, platform });
    const byId = async (reg: AgentRegistry, id: string) => (await reg.list()).find(info => info.id === id);

    test('an installed native agent is ready with its version and launch line; one that is not is missing and says so', async () => {
        const path = program('cursor-agent', 'cursor 2026.09.01');
        const reg = registry();

        expect(await byId(reg, 'cursor')).toEqual({
            id: 'cursor',
            name: 'Cursor',
            custom: false,
            enabled: true,
            status: 'ready',
            path,
            version: '2026.09.01',
            launch: 'cursor-agent acp',
            login: 'cursor-agent login',
            settings: [expect.objectContaining({ id: 'promptSuggestions', value: true })],
            permissions: GENERIC_PERMISSIONS,
        });
        expect(await byId(reg, 'opencode')).toMatchObject({
            status: 'missing',
            detail: expect.stringContaining('no `opencode` command was found'),
            launch: 'opencode acp',
        });
    });

    test('a provider that is only a spec is a working agent: found, started and kept apart from the others, with no change to the registry', async () => {
        const path = program('plain-agent', 'plain 1.0.0');
        const reg = new AgentRegistry({
            discovery: discovery(),
            providers: [
                {
                    spec: {
                        id: 'plain',
                        name: 'Plain',
                        programs: ['plain-agent'],
                        launch: { kind: 'binary', args: ['--acp'] },
                        login: 'plain-agent login',
                    },
                },
            ],
        });

        expect(await reg.list()).toEqual([
            {
                id: 'plain',
                name: 'Plain',
                custom: false,
                enabled: true,
                status: 'ready',
                path,
                version: '1.0.0',
                launch: 'plain-agent --acp',
                login: 'plain-agent login',
                settings: [expect.objectContaining({ id: 'promptSuggestions', value: true })],
                permissions: GENERIC_PERMISSIONS,
            },
        ]);
        expect(await reg.resolve('plain')).toMatchObject({
            ok: true,
            agent: { id: 'plain', command: path, args: ['--acp'], protocol: 'v1' },
        });
        expect(reg.has('plain')).toBe(true);
        expect(reg.has('cursor')).toBe(false);
        expect(() => reg.add({ id: 'plain', name: 'Again', command: 'x', args: [] })).toThrow(AgentRegistryError);
    });

    test('the task tools reach an agent through the shell unless its spec says it uses MCP; a custom agent says it in agents.json', () => {
        const reg = registry();

        reg.add({ id: 'mine', name: 'Mine', command: 'my-agent', args: [] });
        reg.add({ id: 'sandboxed', name: 'Sandboxed', command: 'my-other-agent', args: [], taskTools: 'mcp' });

        for (const spec of SPECS) {
            expect(reg.taskChannel(spec.id)).toBe(spec.taskTools ?? 'cli');
        }

        expect(reg.taskChannel('mine')).toBe('cli');
        expect(reg.taskChannel('sandboxed')).toBe('mcp');
        expect(reg.taskChannel('nobody')).toBe('cli');
    });

    test('a custom agent can opt into verified elicitation in its saved properties', async () => {
        program('my-agent', 'agent 1');
        const dataDir = join(root, 'data');
        const reg = registry(dataDir);
        reg.add({ id: 'mine', name: 'Mine', command: 'my-agent', args: [], elicitation: true });
        expect(await registry(dataDir).resolve('mine')).toMatchObject({ ok: true, agent: { elicitation: true } });
        expect(registry(dataDir).questionElicitation('mine')).toBe(true);
        expect(registry(dataDir).questionElicitation('cursor')).toBe(false);
        expect(registry(dataDir).questionElicitation('codex')).toBe(true);
        expect(registry(dataDir).questionElicitation('claude')).toBe(true);
        expect(registry(dataDir).questionElicitation('unknown')).toBeUndefined();
    });

    test("on macOS a run of Cursor keeps its state in a folder of Clowdy's own (owner only), and Cursor learns that the client can show a model's effort", async () => {
        const cursor = program('cursor-agent', 'cursor 2026.09.01');
        const dataDir = join(root, 'data');
        const resolved = await registry(dataDir, 'darwin').resolve('cursor');
        const folder = join(dataDir, 'agents', 'cursor');

        expect(resolved).toMatchObject({
            ok: true,
            agent: {
                command: cursor,
                args: ['acp'],
                env: { CURSOR_CONFIG_DIR: folder },
                clientMeta: { parameterizedModelPicker: true },
            },
        });
        // The folder exists before the agent starts; it holds the session history, so only its owner reads it.
        expect(statSync(folder).isDirectory()).toBe(true);
        expect(statSync(folder).mode & 0o777).toBe(0o700);
        // The other agents are never moved, and have nothing to say to `initialize`.
        program('opencode', 'opencode 1.0.0');

        const opencode = (await registry(dataDir, 'darwin').resolve('opencode')) as {
            agent: { env: Record<string, string>; clientMeta?: unknown };
        };

        expect(opencode.agent.env).not.toHaveProperty('CURSOR_CONFIG_DIR');
        expect(opencode.agent).not.toHaveProperty('clientMeta');

        // An agent the person added is a command with arguments and variables, nothing more.
        const reg = registry(dataDir, 'darwin');

        reg.add({ id: 'mine', name: 'Mine', command: program('mine', 'x'), args: [], env: { A: '1' } });

        const mine = (await reg.resolve('mine')) as { agent: { env: Record<string, string>; clientMeta?: unknown } };

        expect(mine.agent.env).toEqual({ A: '1' });
        expect(mine.agent).not.toHaveProperty('clientMeta');
    });

    test("the person's own folder for Cursor wins, and no folder of Clowdy's is made then", async () => {
        program('cursor-agent', 'cursor 2026.09.01');

        const dataDir = join(root, 'data');
        const own = registry(dataDir, 'darwin');

        own.update('cursor', { env: { CURSOR_CONFIG_DIR: '/mine' } });
        expect(await own.resolve('cursor')).toMatchObject({ ok: true, agent: { env: { CURSOR_CONFIG_DIR: '/mine' } } });
        expect(existsSync(join(dataDir, 'agents'))).toBe(false);
    });

    test('Cursor is moved only where that is verified, and only with a data folder of its own', async () => {
        program('cursor-agent', 'cursor 2026.09.01');

        const dataDir = join(root, 'data');
        const envOf = async (reg: AgentRegistry) =>
            ((await reg.resolve('cursor')) as { agent: { env: Record<string, string> } }).agent.env;

        // Windows and Linux are not verified: the login may not survive, so a run keeps the person's own folder there.
        expect(await envOf(registry(dataDir, 'win32'))).not.toHaveProperty('CURSOR_CONFIG_DIR');
        expect(await envOf(registry(dataDir, 'linux'))).not.toHaveProperty('CURSOR_CONFIG_DIR');
        expect(existsSync(join(dataDir, 'agents'))).toBe(false);
        // A bare registry (no data folder) has nowhere to put it.
        expect(await envOf(registry(undefined, 'darwin'))).not.toHaveProperty('CURSOR_CONFIG_DIR');
        // The client capability is for every platform.
        expect(await registry(dataDir, 'win32').resolve('cursor')).toMatchObject({
            ok: true,
            agent: { clientMeta: { parameterizedModelPicker: true } },
        });
    });

    test("only a run makes Cursor's folder: a listing, a read (the account, the models) and the sign-in touch no disk and do not name it", async () => {
        program('cursor-agent', 'cursor 2026.09.01');

        const dataDir = join(root, 'data');
        const reg = registry(dataDir, 'darwin');

        expect(await byId(reg, 'cursor')).toMatchObject({ status: 'ready' });

        const target = await reg.probeTarget('cursor', { HOME: '/h', CURSOR_CONFIG_DIR: '/theirs' });

        // A read is the person\'s own Cursor (nothing in it chooses a model), and the sign-in has to land where their own program and the account read look.
        expect(target?.env).toMatchObject({ CURSOR_CONFIG_DIR: '/theirs' });
        expect(existsSync(join(dataDir, 'agents'))).toBe(false);
        expect((await reg.probeTarget('cursor', { HOME: '/h' }))?.env).not.toHaveProperty('CURSOR_CONFIG_DIR');

        // An override of the agent in agents.json reaches a read the same way, and the account read looks there first.
        reg.update('cursor', { env: { CURSOR_CONFIG_DIR: '/mine' } });
        expect((await reg.probeTarget('cursor', { HOME: '/h' }))?.env).toMatchObject({ CURSOR_CONFIG_DIR: '/mine' });
    });

    test('a folder that cannot be made fails the run with a message instead of throwing, and breaks neither the listing nor a read', async () => {
        const cursor = program('cursor-agent', 'cursor 2026.09.01');
        const dataDir = join(root, 'data');

        mkdirSync(dataDir);
        // `agents` is a file, so nothing can be made under it.
        writeFileSync(join(dataDir, 'agents'), 'not a folder');

        const reg = registry(dataDir, 'darwin');
        const resolved = await reg.resolve('cursor');

        expect(resolved).toEqual({
            ok: false,
            message: expect.stringContaining(`could not make ${join(dataDir, 'agents', 'cursor')}`),
        });
        // Starting on the person\'s own folder instead would change their default model, which is what the folder is for.
        expect(await byId(reg, 'cursor')).toMatchObject({ status: 'ready', path: cursor });
        expect((await reg.probeTarget('cursor'))?.program).toBe(cursor);
    });

    test("Claude Code starts through its official adapter on the user's own claude, with the cautions of its profile", async () => {
        const claude = program('claude', '2.1.325 (Claude Code)');
        const reg = registry();

        expect(await byId(reg, 'claude')).toEqual({
            id: 'claude',
            name: 'Claude Code',
            custom: false,
            enabled: true,
            status: 'ready',
            path: claude,
            version: '2.1.325',
            launch: `bun x --bun ${pinned('claude')}`,
            fetches: pinned('claude'),
            login: 'claude auth login',
            canCompact: true,
            settings: expect.any(Array),
            permissions: expect.any(Object),
        });

        const resolved = await reg.resolve('claude');

        expect(resolved).toMatchObject({
            ok: true,
            agent: { command: process.execPath, args: ['x', '--bun', pinned('claude')] },
        });
        expect(resolved.ok && resolved.agent.env).toMatchObject({
            CLAUDE_CODE_EXECUTABLE: claude,
            ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        });
        expect(resolved.ok && resolved.agent.scrub.some(pattern => pattern.test('ANTHROPIC_API_KEY'))).toBe(true);
        // Its provider's default preset (Approve for me) asks, so Clowdy's own command is let through.
        expect(resolved.ok && resolved.agent.sessionMeta).toEqual({
            claudeCode: {
                options: { disallowedTools: ['AskUserQuestion', 'ExitPlanMode'], allowedTools: ['Bash(clowdy:*)'] },
            },
        });
        expect(resolved.ok && resolved.agent.permission).toEqual({ preset: 'auto', mode: 'auto', answer: 'ask' });
    });

    describe('settings', () => {
        const settingsOf = async (reg: AgentRegistry, id = 'claude') =>
            Object.fromEntries(((await byId(reg, id))?.settings ?? []).map(setting => [setting.id, setting.value]));
        const start = async (reg: AgentRegistry, id = 'claude') => {
            const resolved = await reg.resolve(id);

            if (!resolved.ok) {
                throw new Error(resolved.message);
            }

            return resolved.agent;
        };

        test('Claude Code lists its settings at their defaults, and the defaults are what a run gets today', async () => {
            program('claude', '2.1.325 (Claude Code)');

            const reg = registry();

            expect(await settingsOf(reg)).toEqual({
                memory: false,
                connectors: false,
                subagents: true,
                workflows: true,
                longContext: true,
                artifacts: false,
                chatTitle: true,
                commitMessage: false,
                promptSuggestions: true,
            });
            expect((await byId(reg, 'claude'))?.settings?.[0]).toMatchObject({
                id: 'memory',
                default: false,
                label: expect.any(String),
                description: expect.any(String),
            });

            const agent = await start(reg);

            // The CLAUDE.md of the project's other folders is read in every run, whatever the settings.
            expect(agent.env).toMatchObject({
                ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
                CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
                CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            });
            expect(agent.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_1M_CONTEXT');
            expect(agent.env).toMatchObject({ CLAUDE_CODE_ARTIFACT: '0' });
            expect(agent.env).not.toHaveProperty('CODEX_CONFIG');
            expect(agent.sessionMeta).toEqual({
                claudeCode: {
                    options: { disallowedTools: ['AskUserQuestion', 'ExitPlanMode'], allowedTools: ['Bash(clowdy:*)'] },
                },
            });
        });

        test('disabling Claude Code prompt predictions prevents native generation on the next session', async () => {
            program('claude', '2.1.325 (Claude Code)');
            const reg = registry();
            reg.update('claude', { settings: { promptSuggestions: false } });
            const agent = await start(reg);
            expect({ enabled: agent.promptSuggestions, env: agent.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION }).toEqual({
                enabled: false,
                env: 'false',
            });
        });

        test('a setting turned on or off changes the environment and the tools the agent starts with', async () => {
            program('claude', '2.1.325 (Claude Code)');

            const reg = registry();

            reg.update('claude', {
                settings: {
                    memory: true,
                    connectors: true,
                    subagents: false,
                    workflows: false,
                    longContext: false,
                    artifacts: true,
                },
            });

            expect(await settingsOf(reg)).toEqual({
                memory: true,
                connectors: true,
                subagents: false,
                workflows: false,
                longContext: false,
                artifacts: true,
                chatTitle: true,
                commitMessage: false,
                promptSuggestions: true,
            });

            const agent = await start(reg);

            expect(agent.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
            expect(agent.env).not.toHaveProperty('ENABLE_CLAUDEAI_MCP_SERVERS');
            expect(agent.env).toMatchObject({
                CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
                CLAUDE_CODE_ARTIFACT: '1',
                CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3',
            });
            expect(agent.sessionMeta).toEqual({
                claudeCode: {
                    options: {
                        disallowedTools: ['AskUserQuestion', 'ExitPlanMode', 'Agent', 'Task', 'ListAgents', 'Workflow'],
                        allowedTools: ['Bash(clowdy:*)'],
                    },
                },
            });

            // A change names only what it changes.
            reg.update('claude', { settings: { memory: false } });

            expect(await settingsOf(reg)).toEqual({
                memory: false,
                connectors: true,
                subagents: false,
                workflows: false,
                longContext: false,
                artifacts: true,
                chatTitle: true,
                commitMessage: false,
                promptSuggestions: true,
            });
        });

        test("Claude Artifacts is stated off, so a variable the person's own shell sets does not turn it on", async () => {
            program('claude', '2.1.325 (Claude Code)');

            const { env } = await start(registry());

            expect(buildAgentEnv({ daemonEnv: { CLAUDE_CODE_ARTIFACT: '1' }, path: bin, set: env })).toMatchObject({
                CLAUDE_CODE_ARTIFACT: '0',
            });
        });

        test('Codex lists memory and sub-agents next to its chat titles and commit messages, and turns the first two into config keys in one CODEX_CONFIG', async () => {
            program('codex', 'codex-cli 0.166.0');

            const reg = registry();

            expect(await settingsOf(reg, 'codex')).toEqual({
                memory: false,
                subagents: true,
                chatTitle: true,
                commitMessage: false,
                promptSuggestions: true,
            });

            // Memory is stated both ways, so a feature the person turned on in their own Codex does not reach a run that has it off.
            expect(JSON.parse((await start(reg, 'codex')).env.CODEX_CONFIG ?? 'null')).toEqual({
                'features.memories': false,
                'memories.use_memories': false,
                'memories.generate_memories': false,
            });

            reg.update('codex', { settings: { memory: true, subagents: false } });

            expect(await settingsOf(reg, 'codex')).toEqual({
                memory: true,
                subagents: false,
                chatTitle: true,
                commitMessage: false,
                promptSuggestions: true,
            });
            expect(JSON.parse((await start(reg, 'codex')).env.CODEX_CONFIG ?? 'null')).toEqual({
                'features.memories': true,
                'memories.use_memories': true,
                'memories.generate_memories': true,
                'agents.enabled': false,
                'features.multi_agent_v2': false,
            });

            // The variables the person set for the agent win over the ones its settings made.
            reg.update('codex', { env: { CODEX_CONFIG: '{"model":"x"}' } });

            expect((await start(reg, 'codex')).env.CODEX_CONFIG).toBe('{"model":"x"}');
        });

        test('the chat titles of Claude Code and Codex are on, are read by the daemon alone, and an agent without them has none to read', async () => {
            program('claude', '2.1.325 (Claude Code)');
            program('codex', 'codex-cli 0.166.0');

            const reg = registry();

            expect(reg.setting('claude', 'chatTitle')).toBe(true);
            expect(reg.setting('codex', 'chatTitle')).toBe(true);
            expect(reg.setting('cursor', 'chatTitle')).toBeUndefined();
            expect(reg.setting('nobody', 'chatTitle')).toBeUndefined();
            expect((await byId(reg, 'codex'))?.settings?.find(setting => setting.id === 'chatTitle')).toEqual({
                id: 'chatTitle',
                label: 'Chat titles',
                description: 'Let Codex name a new chat from its first message',
                value: true,
                default: true,
            });

            const before = await start(reg);

            reg.update('claude', { settings: { chatTitle: false } });
            expect(reg.setting('claude', 'chatTitle')).toBe(false);
            expect(reg.setting('codex', 'chatTitle')).toBe(true);
            // Nothing about it reaches the agent: it starts as it did.
            expect(await start(reg)).toEqual(before);
        });

        test('the commit messages of Codex and of Claude Code are off, are read by the daemon alone, and no other agent has them', async () => {
            program('claude', '2.1.325 (Claude Code)');
            program('codex', 'codex-cli 0.166.0');

            const reg = registry();

            expect(reg.setting('codex', 'commitMessage')).toBe(false);
            expect(reg.setting('claude', 'commitMessage')).toBe(false);
            expect(reg.setting('cursor', 'commitMessage')).toBeUndefined();
            expect(reg.setting('nobody', 'commitMessage')).toBeUndefined();
            expect((await byId(reg, 'claude'))?.settings?.find(setting => setting.id === 'commitMessage')).toEqual({
                id: 'commitMessage',
                label: 'Commit messages',
                description: 'Send the changed files to Claude Code to write commit messages',
                value: false,
                default: false,
            });
            expect((await byId(reg, 'codex'))?.settings?.find(setting => setting.id === 'commitMessage')).toEqual({
                id: 'commitMessage',
                label: 'Commit messages',
                description: 'Send the changed files to Codex to write commit messages',
                value: false,
                default: false,
            });

            const before = await start(reg, 'codex');
            const claudeBefore = await start(reg);

            reg.update('codex', { settings: { commitMessage: true } });
            reg.update('claude', { settings: { commitMessage: true } });
            expect(reg.setting('codex', 'commitMessage')).toBe(true);
            expect(reg.setting('claude', 'commitMessage')).toBe(true);
            // Nothing about it reaches the agents' own runs: they start as they did.
            expect(await start(reg, 'codex')).toEqual(before);
            expect(await start(reg)).toEqual(claudeBefore);
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
            expect((await byId(registry(dir), 'claude'))?.overrides).toEqual({
                env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'true' },
            });
            expect((await byId(reg, 'cursor'))?.settings).toEqual([
                expect.objectContaining({ id: 'promptSuggestions', value: true }),
            ]);
        });
    });

    describe('permission presets', () => {
        const start = async (reg: AgentRegistry, id: string) => {
            const resolved = await reg.resolve(id);

            if (!resolved.ok) {
                throw new Error(resolved.message);
            }

            return resolved.agent;
        };
        const names = (permissions: { presets: { id: string }[] } | undefined) =>
            permissions?.presets.map(preset => preset.id);

        test("every agent lists the presets its provider declares, in the same names; an agent with no declaration, a custom one included, has the client's pair", async () => {
            program('claude', '2.1.325 (Claude Code)');
            program('codex', 'codex-cli 0.166.0');

            const reg = registry();

            reg.add({ id: 'mine', name: 'Mine', command: 'my-agent', args: [] });

            const claude = (await byId(reg, 'claude'))?.permissions;

            expect(names(claude)).toEqual(['ask', 'accept-edits', 'auto', 'full']);
            expect(claude?.presets.map(preset => preset.name)).toEqual([
                'Ask for approval',
                'Accept edits',
                'Approve for me',
                'Full access',
            ]);
            expect(claude).toMatchObject({ default: 'auto' });
            expect(claude?.value).toBeUndefined();
            expect(names((await byId(reg, 'codex'))?.permissions)).toEqual(['ask', 'accept-edits', 'auto', 'full']);
            expect((await byId(reg, 'codex'))?.permissions?.default).toBe('auto');
            expect((await byId(reg, 'cursor'))?.permissions).toEqual(GENERIC_PERMISSIONS);
            expect((await byId(reg, 'mine'))?.permissions).toEqual(GENERIC_PERMISSIONS);
        });

        test("with no choice an agent runs on its provider's default: Approve for me with its mode on Claude and Codex, the client's Full access on an agent with none of its own", async () => {
            program('claude', '2.1.325 (Claude Code)');
            program('codex', 'codex-cli 0.166.0');

            const reg = registry();

            reg.add({ id: 'mine', name: 'Mine', command: program('my-agent', 'mine 1.0'), args: [] });

            const claude = await start(reg, 'claude');

            expect(claude.permission).toEqual({ preset: 'auto', mode: 'auto', answer: 'ask' });
            expect(claude.sessionMeta).toEqual({
                claudeCode: {
                    options: { disallowedTools: ['AskUserQuestion', 'ExitPlanMode'], allowedTools: ['Bash(clowdy:*)'] },
                },
            });
            expect((await start(reg, 'codex')).permission).toEqual({ preset: 'auto', mode: 'agent', answer: 'ask' });
            // No mode to send, and Clowdy allows what the agent asks: what such an agent has always done.
            expect((await start(reg, 'mine')).permission).toEqual({ preset: 'full', answer: 'allow' });
            // The person's choice is what `AgentInfo` reports; the default is the provider's.
            expect((await byId(reg, 'claude'))?.permissions).toMatchObject({ default: 'auto' });
            expect((await byId(reg, 'claude'))?.permissions?.value).toBeUndefined();
        });

        test("a chosen preset gives the start the mode and the answer of the provider's plan; Claude's presets that ask let Clowdy's own command through", async () => {
            program('claude', '2.1.325 (Claude Code)');
            program('codex', 'codex-cli 0.166.0');

            const reg = registry();

            reg.update('claude', { permission: 'auto' });
            reg.update('codex', { permission: 'full' });

            const claude = await start(reg, 'claude');

            expect(claude.permission).toEqual({ preset: 'auto', mode: 'auto', answer: 'ask' });
            expect(claude.sessionMeta).toEqual({
                claudeCode: {
                    options: { disallowedTools: ['AskUserQuestion', 'ExitPlanMode'], allowedTools: ['Bash(clowdy:*)'] },
                },
            });
            expect((await byId(reg, 'claude'))?.permissions?.value).toBe('auto');
            expect((await start(reg, 'codex')).permission).toEqual({
                preset: 'full',
                mode: 'agent-full-access',
                answer: 'allow',
            });

            reg.update('claude', { permission: 'full' });

            const full = await start(reg, 'claude');

            expect(full.permission).toEqual({ preset: 'full', mode: 'bypassPermissions', answer: 'allow' });
            expect(full.sessionMeta).toEqual({
                claudeCode: { options: { disallowedTools: ['AskUserQuestion', 'ExitPlanMode'] } },
            });
        });

        test("a custom agent on the client's pair is answered by Clowdy and sent no mode", async () => {
            const reg = registry();

            reg.add({ id: 'mine', name: 'Mine', command: program('my-agent', 'mine 1.0'), args: [] });
            reg.update('mine', { permission: 'ask' });

            expect((await start(reg, 'mine')).permission).toEqual({ preset: 'ask', answer: 'ask' });
        });

        test('a preset the agent does not offer is refused, `null` goes back to the default, and a change of something else keeps the choice', async () => {
            program('claude', '2.1.325 (Claude Code)');

            const reg = registry();

            expect(() => reg.update('cursor', { permission: 'auto' })).toThrow('Cursor has no preset called "auto"');
            expect(() => reg.update('nobody', { permission: 'ask' })).toThrow(AgentRegistryError);

            reg.update('claude', { permission: 'accept-edits' });
            reg.update('claude', { settings: { memory: true } });

            expect((await byId(reg, 'claude'))?.permissions?.value).toBe('accept-edits');

            reg.update('claude', { permission: null });

            expect((await byId(reg, 'claude'))?.permissions?.value).toBeUndefined();
            expect((await start(reg, 'claude')).permission).toEqual({ preset: 'auto', mode: 'auto', answer: 'ask' });
        });

        test('are kept in agents.json; a value that is not a preset, or that the agent no longer offers, is ignored', async () => {
            program('claude', '2.1.325 (Claude Code)');

            const dir = mkdtempSync(join(root, 'data-'));

            registry(dir).update('claude', { permission: 'accept-edits' });

            expect((await byId(registry(dir), 'claude'))?.permissions?.value).toBe('accept-edits');

            program('cursor-agent', '2026.11.13');

            writeFileSync(
                join(dir, 'agents.json'),
                JSON.stringify({ overrides: { claude: { permission: 'sandbox' }, cursor: { permission: 'auto' } } })
            );

            const reloaded = registry(dir);

            expect((await byId(reloaded, 'claude'))?.permissions?.value).toBeUndefined();
            // Written by hand, or left from a provider that offered more: shown as unchosen and not applied.
            expect((await byId(reloaded, 'cursor'))?.permissions?.value).toBeUndefined();
            expect((await start(reloaded, 'claude')).permission).toEqual({
                preset: 'auto',
                mode: 'auto',
                answer: 'ask',
            });
            expect((await start(reloaded, 'cursor')).permission).toEqual({ preset: 'full', answer: 'allow' });
        });

        test('a provider declares its own presets and what they do, and the registry, the engine and the protocol need no change for it', async () => {
            const path = program('stub-agent', 'stub 1.0.0');
            const reg = new AgentRegistry({
                discovery: discovery(),
                providers: [
                    {
                        spec: {
                            id: 'stub',
                            name: 'Stub',
                            programs: ['stub-agent'],
                            launch: { kind: 'binary', args: ['--acp'] },
                        },
                        permissions: {
                            presets: [
                                { id: 'accept-edits', description: 'Stub edits files' },
                                { id: 'auto', description: 'Stub decides' },
                            ],
                            default: 'accept-edits',
                            apply: preset => ({
                                mode: preset === 'auto' ? 'smart' : 'files',
                                effect: { env: { STUB_PERMISSIONS: preset } },
                                answer: 'ask',
                            }),
                        },
                    },
                ],
            });

            expect((await reg.list())[0]?.permissions).toEqual({
                presets: [
                    { id: 'accept-edits', name: 'Accept edits', description: 'Stub edits files' },
                    { id: 'auto', name: 'Approve for me', description: 'Stub decides' },
                ],
                default: 'accept-edits',
            });
            expect(() => reg.update('stub', { permission: 'full' })).toThrow('Stub has no preset called "full"');

            // No choice: the provider's own default, with its mode and environment, though the client's pair would have said `full`.
            const untouched = await start(reg, 'stub');

            expect(untouched.permission).toEqual({ preset: 'accept-edits', mode: 'files', answer: 'ask' });
            expect(untouched.env).toMatchObject({ STUB_PERMISSIONS: 'accept-edits' });

            reg.update('stub', { permission: 'auto' });

            const agent = await start(reg, 'stub');

            expect(agent.permission).toEqual({ preset: 'auto', mode: 'smart', answer: 'ask' });
            expect(agent.env).toMatchObject({ STUB_PERMISSIONS: 'auto' });
            expect(agent.command).toBe(path);
        });

        test('the variables the person set win over what a preset sets', async () => {
            program('codex', 'codex-cli 0.166.0');

            const reg = new AgentRegistry({
                discovery: discovery(),
                providers: [
                    {
                        spec: { id: 'stub', name: 'Stub', programs: ['codex'], launch: { kind: 'binary', args: [] } },
                        permissions: {
                            presets: [{ id: 'ask', description: 'x' }],
                            default: 'ask',
                            apply: () => ({ effect: { env: { STUB_MODE: 'preset' } }, answer: 'ask' }),
                        },
                    },
                ],
            });

            reg.update('stub', { permission: 'ask', env: { STUB_MODE: 'person' } });

            expect((await start(reg, 'stub')).env).toMatchObject({ STUB_MODE: 'person' });
        });

        test('what a preset sets wins over what a setting sets, and the default preset sets it too', async () => {
            program('codex', 'codex-cli 0.166.0');

            const reg = new AgentRegistry({
                discovery: discovery(),
                providers: [
                    {
                        spec: {
                            id: 'stub',
                            name: 'Stub',
                            programs: ['codex'],
                            launch: { kind: 'binary', args: [] },
                            settings: [
                                {
                                    id: 'on',
                                    label: 'On',
                                    description: 'x',
                                    default: true,
                                    effect: () => ({ env: { STUB_MODE: 'setting', STUB_SETTING: '1' } }),
                                },
                            ],
                        },
                        permissions: {
                            presets: [{ id: 'ask', description: 'x' }],
                            default: 'ask',
                            apply: () => ({ effect: { env: { STUB_MODE: 'preset' } }, answer: 'ask' }),
                        },
                    },
                ],
            });

            // Nothing chosen: the default preset's effect comes after the setting's, and the setting's other variables stay.
            expect((await start(reg, 'stub')).env).toMatchObject({ STUB_MODE: 'preset', STUB_SETTING: '1' });
        });
    });

    test('an adapter agent needs its program and a Bun to fetch the adapter; both are named when one is missing', async () => {
        const codex = program('codex', 'codex-cli 0.166.0');
        let bun: string | undefined;
        const reg = new AgentRegistry({ discovery: discovery(), runtime: async () => bun });

        expect(await byId(reg, 'codex')).toMatchObject({
            status: 'needs-runtime',
            path: codex,
            detail: expect.stringContaining('bun x'),
            fetches: pinned('codex'),
        });

        bun = program('bun', '1.4.0');
        reg.refresh();

        expect(await byId(reg, 'codex')).toMatchObject({ status: 'ready', version: '0.166.0', canCompact: true });
        expect(await byId(reg, 'claude')).toMatchObject({ status: 'missing' });
    });

    test("an adapter starts through the daemon's own Bun (`bun x --bun`) with the user's own program, and without optional dependencies", async () => {
        const codex = program('codex', 'x');
        const resolved = await registry().resolve('codex');

        expect(resolved).toMatchObject({
            ok: true,
            agent: { command: process.execPath, args: ['x', '--bun', pinned('codex')] },
        });
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

        expect(await byId(reg, 'mine')).toMatchObject({
            custom: true,
            status: 'ready',
            path: tool,
            version: '3.0',
            launch: 'my-agent --acp',
        });
        expect(await reg.resolve('mine')).toMatchObject({
            ok: true,
            agent: { command: tool, args: ['--acp'], env: { A: '1', B: '2' } },
        });
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
        } finally {
            console.warn = warn;
        }

        expect(warnings[0]).toContain('could not be read');
    });

    test("a change names what it changes: the rest of the agent's settings stay, even when the caller passes them as undefined", async () => {
        const chosen = program('my-opencode', 'x');
        const reg = registry();

        reg.update('opencode', { enabled: false, env: { KEY: 'v' } });
        reg.update('opencode', { enabled: undefined, env: undefined, path: chosen });

        expect(await byId(reg, 'opencode')).toMatchObject({ status: 'disabled', path: chosen });

        reg.update('opencode', { enabled: true });

        expect(await reg.resolve('opencode')).toMatchObject({
            ok: true,
            agent: { command: chosen, env: { KEY: 'v' } },
        });
    });

    test('a program is a name or an absolute path: a relative one would be read against the wrong folder', () => {
        const reg = registry();

        expect(() => reg.add({ id: 'rel', name: 'Rel', command: './agent', args: [] })).toThrow(
            /program name or an absolute path/
        );
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

        expect(resolved.ok && resolved.agent.env).toMatchObject({
            ENABLE_CLAUDEAI_MCP_SERVERS: 'true',
            ANTHROPIC_API_KEY: 'k',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        });
    });

    test('agents.json keeps what is usable of a damaged file, and what is written is private to the user', () => {
        const dataDir = join(root, 'data');

        mkdirSync(dataDir);
        writeFileSync(
            join(dataDir, 'agents.json'),
            JSON.stringify({
                agents: [
                    null,
                    7,
                    { id: 'good', command: ' tool ', args: ['a', 1], env: { A: '1' } },
                    { id: 'claude', command: 'x' },
                    { id: 'fake', command: 'x' },
                    { id: 'Bad Id', command: 'x' },
                    { id: 'nocommand' },
                    { id: 'twice', command: 'first' },
                    { id: 'twice', command: 'second' },
                    { id: 'badenv', command: 'x', env: { A: 1 } },
                ],
                overrides: {
                    cursor: { enabled: 'no', path: 5, env: { A: 1 } },
                    opencode: { enabled: false, path: '/x/opencode', env: { K: 'v' } },
                    gemini: 7,
                },
            })
        );

        const reg = registry(dataDir);

        reg.update('good', { name: 'Good one' });

        const saved = JSON.parse(readFileSync(join(dataDir, 'agents.json'), 'utf8'));

        expect(saved.agents).toEqual([
            { id: 'good', name: 'Good one', command: 'tool', args: ['a', '1'], env: { A: '1' } },
            { id: 'twice', name: 'twice', command: 'first', args: [] },
            { id: 'badenv', name: 'badenv', command: 'x', args: [] },
        ]);
        expect(saved.overrides).toEqual({
            cursor: {},
            good: {},
            opencode: { enabled: false, path: '/x/opencode', env: { K: 'v' } },
        });
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
