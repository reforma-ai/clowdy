import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@clowdy/protocol';

import pkg from '../package.json';
import { AttachmentsService } from './attachments/service';
import { installShimOrWarn } from './cli/shim';
import { openDatabase } from './db/connection';
import { listProjects } from './db/projects';
import { ensurePersonalProject } from './domain/projects';
import { createEngines } from './engine';
import { CHAT_TITLE_SETTING } from './engine/acp/catalog';
import { AgentRegistry } from './engine/acp/registry';
import { FilesService } from './files/service';
import { FsService } from './fs/service';
import { GitBranchMerge } from './git/branchMerge';
import { GitClone } from './git/clone';
import { GitWrites } from './git/commit';
import { GitDiscard } from './git/discard';
import { pruneDiscardCopies } from './git/discardCopies';
import { CommitMessages } from './git/message';
import { PullRequests } from './git/pullRequest';
import { GitRemote } from './git/remote';
import { GitSwitch } from './git/switch';
import { WriteEnvironment } from './git/writeEnv';
import { startServer } from './http/server';
import { acquireLock, writeDaemonInfo } from './instance';
import { PowerService, type SleepBlocker } from './power';
import { announceAgentsChanged } from './providers/announce';
import { TextGeneration } from './providers/generate';
import { ModelCatalog } from './providers/models';
import { ProvidersService } from './providers/service';
import { RunDriver } from './runs/driver';
import { ThreadNotices } from './runs/notices';
import { ChatQueue } from './runs/queue';
import { RunService } from './runs/service';
import { ThreadService } from './runs/threads';
import { toolsFor } from './runs/tools';
import { SkillsService } from './skills/service';
import { Store } from './store';
import { TerminalService } from './terminals/service';

import type { DaemonInfo } from '@clowdy/protocol';
import type { Services } from './commands';
import type { Config } from './config';
import type { EngineRegistry } from './engine/types';

/** Set by `scripts/bundle.ts`: the version of the app bundle this daemon was built into. */
declare const __CLOWDY_BUNDLE_VERSION__: string | undefined;

/** What `/v1/health` reports: the bundle's version, or the package's when the daemon runs from its sources. The app compares it with the bundle it runs. */
const VERSION = typeof __CLOWDY_BUNDLE_VERSION__ === 'string' ? __CLOWDY_BUNDLE_VERSION__ : pkg.version;

export interface Daemon {
    info: DaemonInfo;
    services: Services;
    /** Aborts live work, closes the server and the database, removes `daemon.json` and the lock. */
    stop(): Promise<void>;
}

export interface DaemonOptions {
    /** Replaces the engine registry; tests use it to script engines. */
    engines?: EngineRegistry;
    /** Replaces the agent registry; tests use it to keep the agents installed on the machine out of the run. */
    agents?: AgentRegistry;
    /** Replaces the reader of accounts and usage; tests use it to keep the real programs out of the run. */
    providers?: ProvidersService;
    /** Replaces the reader of model lists; tests use it to keep the real programs out of the run. */
    models?: ModelCatalog;
    /** Replaces the terminal service; tests use it to run a shell of their own on a PTY of their own. */
    terminals?: TerminalService;
    /** Replaces the reader of pull requests; tests use it to put a `gh` of their own in the place of the person's. */
    pullRequests?: PullRequests;
    /** Replaces the environment of the git writes and its search for the signing agent; tests use it to put an `ssh` and a shell of their own in the place of the person's. */
    gitEnvironment?: WriteEnvironment;
    /** Replaces the runner of the agents' no-tools runs (commit messages); tests use it to give a run a limit of its own. */
    textGeneration?: TextGeneration;
    /** The system assertion is supplied by the entry point; test daemons do not change host sleep. */
    sleepBlocker?: SleepBlocker;
    heartbeatMs?: number;
    /** Called once the daemon has stopped because a client asked (`POST /v1/shutdown`); the entry point exits the process here. */
    onShutdown?: () => void;
}

/** Wires everything and starts serving. Throws `AlreadyRunningError` when another daemon owns the data directory. */
export async function startDaemon(config: Config, options: DaemonOptions = {}): Promise<Daemon> {
    const releaseLock = acquireLock(config.dataDir);
    /** Closes what startup has made when a later step throws: it grows with the steps, and is `stop` once the services exist. */
    let undo: () => unknown = releaseLock;

    try {
        const startedAt = Date.now();
        const store = new Store(openDatabase(join(config.dataDir, 'clowdy.db')));
        // Before the engines: runs read `config.systemSkillsDir` when they start.
        const skills = new SkillsService(store, config);
        const agents = options.agents ?? new AgentRegistry({ dataDir: config.dataDir });
        // Before the engines: the agents of sessions with shell commands get the `clowdy` command on their `PATH`.
        const shim = installShimOrWarn(config.dataDir);
        const created = options.engines ? undefined : createEngines(config, agents, process.env, shim);
        const engines = options.engines ?? (created as EngineRegistry);

        undo = () => {
            created?.stop();
            skills.stop();
            store.db.close();
            releaseLock();
        };

        if (!engines.has(config.engine)) {
            throw new Error(
                `CLOWDY_ENGINE=${config.engine} is not an agent this daemon knows: pick fake, claude, codex, cursor, opencode, gemini, copilot, grok, omp, hermes, or the id of a custom agent`
            );
        }

        // Stream items say what the agent behind them can fork (`StreamItem.canFork`, `canEdit`), read from the engine when an item is listed or published.
        store.forkable = engine => engines.get(engine)?.canFork === true;

        const runs = new RunService(store, config, engines);
        const power = new PowerService(
            config.dataDir,
            () => runs.activeCount() > 0,
            options.sleepBlocker ?? { setAwake() {} }
        );
        // A turn asks for its tools when it starts, by which time the thread service below exists.
        const driver = new RunDriver({
            store,
            config,
            runs,
            engines,
            tools: (run, mode) =>
                toolsFor(
                    {
                        store,
                        runs,
                        threads,
                        ...(agents.questionElicitation(run.engine) === false && {
                            pauseQuestion: (id, question) => driver.pauseQuestion(id, question),
                        }),
                    },
                    run,
                    mode,
                    agents.taskChannel(run.engine)
                ),
            compactCommand: engine => agents.compactCommand(engine),
            namesChats: engine => agents.setting(engine, CHAT_TITLE_SETTING),
        });
        const attachments = new AttachmentsService(store, config.dataDir);
        // Before the recovery: a turn the restart interrupted holds its chat's queue.
        const queue = new ChatQueue({ store, runs, driver, attachments });
        // After the queue, whose status hook it extends, and before the recovery, whose interrupted threads it tells their parents of.
        const notices = new ThreadNotices({ store, config, runs, driver, queue, attachments, agents });
        const threads = new ThreadService({ store, config, runs, driver, queue, attachments, agents, notices });
        const providers =
            options.providers ??
            new ProvidersService({
                registry: agents,
                announce: () => announceAgentsChanged(store),
            });
        const files = new FilesService();
        const textGeneration =
            options.textGeneration ??
            new TextGeneration({ target: id => agents.probeTarget(id), dataDir: config.dataDir });
        // One environment for every write, so the signing agent found for a commit is the one a push uses.
        const gitEnvironment = options.gitEnvironment ?? new WriteEnvironment();
        const services: Services = {
            config,
            store,
            runs,
            power,
            driver,
            queue,
            threads,
            files,
            fs: new FsService(files, {}, { ripgrep: config.ripgrep }),
            attachments,
            skills,
            agents,
            providers,
            models: options.models ?? new ModelCatalog({ registry: agents }),
            terminals: options.terminals ?? new TerminalService({ logsDir: join(config.dataDir, 'terminals') }),
            pullRequests: options.pullRequests ?? new PullRequests(),
            gitWrites: new GitWrites({ store, environment: gitEnvironment }),
            gitRemote: new GitRemote({ store, environment: gitEnvironment }),
            gitClone: new GitClone({ projectsDir: config.projectsDir, environment: gitEnvironment }),
            gitBranchMerge: new GitBranchMerge({
                store,
                environment: gitEnvironment,
                workspacesDir: config.workspacesDir,
            }),
            gitSwitch: new GitSwitch({ store, environment: gitEnvironment }),
            gitDiscard: new GitDiscard({ store, environment: gitEnvironment }),
            commitMessages: new CommitMessages({ store, agents, providers, generation: textGeneration }),
        };

        // Expire legacy recovery copies in the background; new discards never create them.
        const pruning = pruneDiscardCopies(config.dataDir).catch(() => undefined);
        // Made once startup has got that far; a startup that fails before has none to close.
        let server: ReturnType<typeof startServer> | undefined;
        let removeInfo: (() => void) | undefined;
        let unsubscribePower: (() => void) | undefined;
        let stopping: Promise<void> | undefined;

        const stop = () =>
            (stopping ??= (async () => {
                // Notices still in their window are lost: their timers must not write to a store that is closing.
                notices.stop();
                unsubscribePower?.();
                power.stop();
                await server?.stop(true);
                // A clone that is stopped takes away what it made before the process may go.
                await services.gitClone.stop();
                services.terminals.stop();
                services.pullRequests.stop();
                services.gitWrites.stop();
                services.gitRemote.stop();
                services.gitBranchMerge.stop();
                services.gitSwitch.stop();
                services.gitDiscard.stop();
                services.commitMessages.stop();
                await pruning;
                await driver.stop();
                created?.stop();
                providers.stop();
                services.models.stop();
                services.fs.stop();
                skills.stop();
                store.db.close();
                removeInfo?.();
                releaseLock();
            })());

        undo = stop;

        await runs.recover();
        attachments.sweep();
        // Before the watchers, so the personal space is watched like any project.
        ensurePersonalProject(store, config);
        skills.watchFolders(listProjects(store.db));
        driver.resumeWaiting();
        queue.resumePending();
        server = startServer({
            services,
            version: VERSION,
            startedAt,
            heartbeatMs: options.heartbeatMs,
            // Answer first: stopping closes the connection this request came in on.
            shutdown: () => void setTimeout(() => void stop().then(options.onShutdown), 50),
        });
        const info: DaemonInfo = {
            pid: process.pid,
            port: server.port as number,
            token: config.token,
            protocol: PROTOCOL_VERSION,
            startedAt,
        };
        removeInfo = writeDaemonInfo(config.dataDir, info);
        unsubscribePower = store.subscribe(events => {
            if (events.some(event => ['run.upserted', 'chat.deleted', 'project.deleted'].includes(event.data.type)))
                power.refresh();
        });
        power.start();

        return { info, services, stop };
    } catch (error) {
        try {
            await undo();
        } catch (cleanup) {
            console.error('[clowdy] closing after a failed start failed:', cleanup);
            releaseLock();
        }

        throw error;
    }
}
