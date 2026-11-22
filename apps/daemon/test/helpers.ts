import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeCommand, executeCommandAsync } from '../src/commands';
import { startDaemon } from '../src/daemon';
import { getPersonalProject, listStatuses } from '../src/db/projects';
import { Discovery } from '../src/engine/acp/discovery';
import { AgentRegistry } from '../src/engine/acp/registry';

import type { ClowdyEvent, Command, CommandResult, EngineId, Project, Run, TaskStatus } from '@clowdy/protocol';
import type { Config } from '../src/config';
import type { Daemon, DaemonOptions } from '../src/daemon';
import type { AgentEngine, EngineEvent, EngineFork, EngineForkOptions, EngineSession, EngineStartOptions } from '../src/engine/types';
import type { Provider } from '../src/providers/types';

const roots: string[] = [];

/** A fresh empty directory, removed when the test file ends. */
/** The `spec` of a provider a test makes up: it names an agent and starts nothing. */
export function testSpec(id: string): Pick<Provider, 'spec'> {
    return { spec: { id, name: id, programs: [id], launch: { kind: 'binary', args: [] } } };
}

export function tempDir(label = 'clowdy-test'): string {
    const dir = mkdtempSync(join(tmpdir(), `${ label }-`));

    roots.push(dir);

    return dir;
}

export function cleanTempDirs(): void {
    for (const dir of roots.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
}

const GIT_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

export function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(['git', ...GIT_IDENTITY, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

    if (result.exitCode !== 0) {
        throw new Error(`git ${ args.join(' ') } failed: ${ result.stderr.toString() }`);
    }

    return result.stdout.toString().trim();
}

/** A throwaway repository with one commit. */
export function makeRepo(parent: string, name = 'repo'): string {
    const path = join(parent, name);

    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    writeFileSync(join(path, 'README.md'), '# Test\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'Initial commit');

    return path;
}

/** Delays of the runtime shrunk for tests. */
export const SHORT_TIMINGS = { killGraceMs: 150, retryBaseMs: 10, pauseJitterMs: 0, noticeWindowMs: 30 };

export function testConfig(overrides: Partial<Config> = {}): Config {
    const root = tempDir();

    return {
        dataDir: join(root, 'data'),
        projectsDir: join(root, 'projects'),
        personalDir: join(root, 'personal'),
        port: 0,
        token: 'test-token',
        corsOrigins: [],
        engine: 'fake',
        maxRuns: 8,
        engineCaps: { claude: 6, codex: 4, fake: 1000 },
        defaultEngineCap: 4,
        agentPermissions: 'allow',
        maxProcesses: 24,
        maxThreadDepth: 3,
        maxActiveThreads: 30,
        maxThreads: 300,
        timings: SHORT_TIMINGS,
        fakeSpeed: 0,
        ...overrides,
    };
}

let counter = 0;

export function command(type: Command['type'], fields: Record<string, unknown> = {}): Command {
    return { requestId: `req-${ Date.now() }-${ ++counter }`, type, ...fields } as unknown as Command;
}

export class Harness {
    constructor(readonly daemon: Daemon, readonly config: Config) {}

    get url(): string {
        return `http://127.0.0.1:${ this.daemon.info.port }`;
    }

    get store() {
        return this.daemon.services.store;
    }

    /** The personal space every daemon makes at start: the first project, before any a test opens. */
    get personal(): Project {
        return getPersonalProject(this.store.db) as Project;
    }

    statuses(projectId: string): TaskStatus[] {
        return listStatuses(this.store.db, projectId);
    }

    /** Executes a command directly and returns its result. */
    send(type: Command['type'], fields: Record<string, unknown> = {}): CommandResult {
        return executeCommand(this.daemon.services, command(type, fields));
    }

    /** Executes a command and returns its `data`, failing the test when it did not succeed. */
    ok(type: Command['type'], fields: Record<string, unknown> = {}): any {
        const result = this.send(type, fields);

        if (!result.ok) {
            throw new Error(`${ type } failed: ${ result.error.code } ${ result.error.message }`);
        }

        return result.data;
    }

    /** Executes any command, one that waits for an agent (`chat.fork`) included, and returns its result. */
    sendAsync(type: Command['type'], fields: Record<string, unknown> = {}): Promise<CommandResult> {
        return executeCommandAsync(this.daemon.services, command(type, fields));
    }

    /** Executes any command and returns its `data`, failing the test when it did not succeed. */
    async okAsync(type: Command['type'], fields: Record<string, unknown> = {}): Promise<any> {
        const result = await this.sendAsync(type, fields);

        if (!result.ok) {
            throw new Error(`${ type } failed: ${ result.error.code } ${ result.error.message }`);
        }

        return result.data;
    }

    fetch(path: string, init: RequestInit = {}): Promise<Response> {
        return fetch(`${ this.url }${ path }`, { ...init, headers: { authorization: `Bearer ${ this.config.token }`, ...init.headers } });
    }

    events(after = 0): ClowdyEvent[] {
        return this.store.eventsAfter(after, undefined, 100_000);
    }

    run(runId: string): Run {
        return this.daemon.services.runs.require(runId);
    }

    openRepo(name?: string): { id: string; path: string } {
        const path = makeRepo(this.config.projectsDir, name);
        const { project } = this.ok('project.add', { folders: [path] });

        return { id: project.id, path: project.folders[0].path };
    }

    async stop(): Promise<void> {
        await this.daemon.stop();
    }
}

/**
 * The agent registry of a test daemon: it finds no agent on the machine (no search path, no login shell, no version
 * probe of a program someone installed), so a test sees only the agents it adds itself.
 */
export function testAgents(config: Config): AgentRegistry {
    return new AgentRegistry({ dataDir: config.dataDir, discovery: new Discovery({ env: { PATH: '' }, loginPath: async () => undefined, installDirs: [] }) });
}

export async function startHarness(overrides: Partial<Config> = {}, options: DaemonOptions = {}): Promise<Harness> {
    const config = testConfig(overrides);

    return new Harness(await startDaemon(config, { agents: testAgents(config), ...options }), config);
}

/** Restarts a daemon on the data directory of an earlier harness. */
export async function restartHarness(previous: Harness, options: DaemonOptions = {}, overrides: Partial<Config> = {}): Promise<Harness> {
    const config = { ...previous.config, ...overrides };

    return new Harness(await startDaemon(config, { agents: testAgents(config), ...options }), config);
}

export async function waitFor<T>(check: () => T | undefined | false | null, what: string, timeoutMs = 4000): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        const value = check();

        if (value) {
            return value;
        }

        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${ what }`);
        }

        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

/**
 * An engine whose sessions block until the test releases them, for exercising the scheduler and cancellation.
 * A session is identified by a substring of its prompt (a chat started from a task gets `Complete task KEY: title`).
 */
export class GateEngine implements AgentEngine {
    readonly id: EngineId = 'fake';
    readonly started: string[] = [];
    readonly aborted: string[] = [];
    private gates = new Map<string, () => void>();

    start(options: EngineStartOptions): EngineSession {
        this.started.push(options.prompt);

        const gates = this.gates;
        const aborted = this.aborted;

        return {
            close() {},
            async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
                yield { type: 'session', sessionId: `gate-${ options.prompt }` };
                yield { type: 'text', delta: 'working', done: true };

                await new Promise<void>((resolve, reject) => {
                    gates.set(options.prompt, resolve);
                    options.signal.addEventListener('abort', () => {
                        aborted.push(options.prompt);
                        reject(options.signal.reason);
                    }, { once: true });
                });

                yield { type: 'done', result: `finished ${ options.prompt }` };
            },
        };
    }

    isStarted(match: string): boolean {
        return this.started.some(prompt => prompt.includes(match));
    }

    release(match: string): void {
        const entry = [...this.gates].find(([prompt]) => prompt.includes(match));

        if (!entry) {
            throw new Error(`No gated session matches ${ match }`);
        }

        this.gates.delete(entry[0]);
        entry[1]();
    }
}

export const gateEngines = (engine: GateEngine) => new Map<EngineId, AgentEngine>([['fake', engine]]);

/** What a script sees of one session: the start options and a way to call the runtime's tools like a model would. */
export interface Turn {
    options: EngineStartOptions;
    /** Aborts when the run is cancelled, the turn is interrupted, or the runtime closes the session. */
    signal: AbortSignal;
    /** The 1-based number of this session among all the engine started. */
    number: number;
    /** Runs a tool the runtime gave this session and reports it as tool events. Returns what the tool returned. */
    call(name: string, input?: unknown): AsyncGenerator<EngineEvent, any>;
    /**
     * For a session that outlives its `done`: resolves with the next text the runtime handed to `send` and the engine took (see `sendAnswer`), oldest
     * first, and `undefined` once the session is over (closed, aborted, or the script ended), which is the script's cue to return, as the iterator of a
     * closed ACP session ends without an error. The script answers a text with the events of a turn and ends them with `done`.
     */
    received(): Promise<string | undefined>;
    /**
     * For a session that can end one sub-agent alone (see `stopAnswer`): resolves with the `agentId` the runtime asked to stop next, oldest first, and
     * `undefined` once the session is over. The script answers it as an agent does, with the events that end that sub-agent (`subagent` with state
     * `cancelled`, and the snapshot without it).
     */
    stopRequested(): Promise<string | undefined>;
    /**
     * Waits for `latch` or for the end of the session, whichever comes first: `true` when the test released the latch (the background work finished, say),
     * `false` when the session ended first, and the script returns. A script that waited on the latch with `latch.wait(turn.signal)` would throw then.
     */
    hold(latch: { wait(signal?: AbortSignal): Promise<void> }): Promise<boolean>;
}

export type Script = (turn: Turn) => AsyncGenerator<EngineEvent>;

/**
 * An engine whose sessions run a script the test wrote: the script yields engine events and calls tools through
 * `turn.call`. It decides by the options (role, prompt, resume id) what this session does.
 *
 * A script may go on after it yields `done`, as the session of an agent with background work does: it yields `background` snapshots, waits for
 * the test with `turn.hold`, yields the events of a turn the agent starts on its own (no prompt behind it) and ends it with `done` again, answers
 * what `send` handed over (`turn.received`), and ends the iterator by returning. The runtime closes the session meanwhile, or aborts it, and the
 * script's wait then ends (`hold` and `received` answer `false` and `undefined`). With a `stopAnswer` its sessions can end one sub-agent alone
 * (`stopItem`), and the script hears the request with `turn.stopRequested()`.
 */
export class ScriptEngine implements AgentEngine {
    readonly id: EngineId = 'fake';
    readonly turns: EngineStartOptions[] = [];
    /** Messages the runtime steered into live sessions, in order, whatever the answer. */
    readonly steered: string[] = [];
    /** Answers a steer; without it every steer is refused, and the session says it cannot steer at all (`EngineSession.canSteer`). */
    steerAnswer?: (text: string, turn: Turn) => boolean | Promise<boolean>;
    /** Prompts the runtime handed to `send` of a live session, in order, whatever the answer. */
    readonly sent: string[] = [];
    /**
     * Answers a `send`: `true` takes the text (the script reads it with `turn.received()`), `false` refuses it. Without it the sessions have no `send`
     * at all, as those of an engine that cannot take a prompt after its turn, which is what every session was before it existed. A session that is
     * over refuses whatever this says. It decides when a session starts whether that session has `send`, and when `send` is called what it answers.
     */
    sendAnswer?: (text: string, turn: Turn) => boolean | Promise<boolean>;
    /** The sub-agents the runtime asked a session to stop alone (`stopItem`), in order, whatever the answer. */
    readonly stopRequests: string[] = [];
    /**
     * Answers a `stopItem`: `true` takes the request (the script reads it with `turn.stopRequested()` and ends the sub-agent), `false` refuses it. Without
     * it the sessions have no `stopItem` at all, as those of an engine that cannot end one sub-agent alone. A session that is over refuses whatever this says.
     */
    stopAnswer?: (agentId: string, turn: Turn) => boolean | Promise<boolean>;
    /** The agent starts no turn of its own to report background work that ended (`EngineSession.wakesOnBackgroundEnd`): its sessions say so. */
    wakes = false;
    /** The app may offer Fork and Edit for chats of this engine (`AgentEngine.canFork`). Off by default, as for every agent the catalog does not flag. */
    canFork = false;
    /** The forks the runtime asked of the engine, in order, whatever the answer. */
    readonly forked: EngineForkOptions[] = [];
    /**
     * Answers a `fork`: the new session, or a throw that fails it. Without it a fork of session `s` is `s-fork-<n>`, n counting the forks so far.
     */
    forkAnswer?: (options: EngineForkOptions) => EngineFork | Promise<EngineFork>;
    closed = 0;
    /** When each session started and finished closing (epoch ms), by session number minus one. */
    readonly startedAt: number[] = [];
    readonly closedAt: number[] = [];
    private calls = 0;

    /** `closeMs` makes `close()` slow, like an engine that takes a moment to shut its process down. */
    constructor(private script: Script, private closeMs = 0) {}

    async fork(options: EngineForkOptions): Promise<EngineFork> {
        this.forked.push(options);

        return await this.forkAnswer?.(options) ?? { sessionId: `${ options.sessionId }-fork-${ this.forked.length }` };
    }

    start(options: EngineStartOptions): EngineSession {
        this.turns.push(options);
        this.startedAt.push(Date.now());

        const number = this.turns.length;
        const script = this.script;
        const engine = this;
        const closing = new AbortController();
        const inbox: string[] = [];
        const stops: string[] = [];
        const waiting: (() => void)[] = [];
        let over = false;

        const wake = () => waiting.splice(0).forEach(resolve => resolve());
        const turn: Turn = {
            options,
            signal: AbortSignal.any([options.signal, closing.signal]),
            number,
            async received() {
                while (!over && !turn.signal.aborted && inbox.length === 0) {
                    await new Promise<void>(resolve => waiting.push(resolve));
                }

                return over || turn.signal.aborted ? undefined : inbox.shift();
            },
            async stopRequested() {
                while (!over && !turn.signal.aborted && stops.length === 0) {
                    await new Promise<void>(resolve => waiting.push(resolve));
                }

                return over || turn.signal.aborted ? undefined : stops.shift();
            },
            async hold(latch) {
                try {
                    await latch.wait(turn.signal);

                    return true;
                }
                catch {
                    return false;
                }
            },
            async *call(name, input = {}) {
                const tool = options.tools.find(candidate => candidate.name === name);

                if (!tool) {
                    throw new Error(`No ${ name } tool in this session (${ options.tools.map(candidate => candidate.name).join(', ') })`);
                }

                const toolCallId = `script-call-${ ++engine.calls }`;

                yield { type: 'tool', toolCallId, name, input, state: 'running' };

                try {
                    const output = await tool.execute(input, options.signal);

                    yield { type: 'tool', toolCallId, name, input, state: 'done', output };

                    return output;
                }
                catch (error) {
                    yield { type: 'tool', toolCallId, name, input, state: 'error', error: error instanceof Error ? error.message : String(error) };
                    throw error;
                }
            },
        };

        turn.signal.addEventListener('abort', wake, { once: true });

        return {
            // An engine with no `steerAnswer` is one whose agent cannot steer at all, which is what the runtime offers stop and send for.
            get canSteer() {
                return engine.steerAnswer !== undefined;
            },
            ...(engine.wakes && { wakesOnBackgroundEnd: true as const }),
            steer: async (text) => {
                engine.steered.push(text);

                return await engine.steerAnswer?.(text, turn) ?? false;
            },
            ...(engine.sendAnswer && {
                send: async (text: string) => {
                    engine.sent.push(text);

                    if (over || turn.signal.aborted || !await engine.sendAnswer?.(text, turn)) {
                        return false;
                    }

                    inbox.push(text);
                    wake();

                    return true;
                },
            }),
            ...(engine.stopAnswer && {
                stopItem: async (agentId: string) => {
                    engine.stopRequests.push(agentId);

                    if (over || turn.signal.aborted || !await engine.stopAnswer?.(agentId, turn)) {
                        return false;
                    }

                    stops.push(agentId);
                    wake();

                    return true;
                },
            }),
            close: async () => {
                engine.closed++;
                closing.abort();

                if (engine.closeMs > 0) {
                    await Bun.sleep(engine.closeMs);
                }

                engine.closedAt[number - 1] = Date.now();
            },
            async *[Symbol.asyncIterator]() {
                try {
                    yield* script(turn);
                }
                finally {
                    over = true;
                    wake();
                }
            },
        };
    }

    /** Prompts of the sessions started so far. */
    get prompts(): string[] {
        return this.turns.map(options => options.prompt);
    }
}

export const scriptEngines = (engine: AgentEngine) => new Map<EngineId, AgentEngine>([['fake', engine]]);

/** Resolves when `release()` is called; scripts use it to hold a session open until the test says so. Rejects when `signal` aborts first. */
export function latch(): { wait(signal?: AbortSignal): Promise<void>; release(): void } {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });

    return {
        release,
        wait: signal => new Promise<void>((resolve, reject) => {
            void released.then(resolve);

            if (signal?.aborted) {
                reject(signal.reason);
            }

            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
}

/** Never resolves; rejects when `signal` aborts. A session that is waiting for the model uses it. */
export function untilAborted(signal: AbortSignal): Promise<never> {
    return latch().wait(signal) as Promise<never>;
}
