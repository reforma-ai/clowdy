import { PROTOCOL_VERSION } from '@clowdy/protocol';
import { join } from 'node:path';

import pkg from '../package.json';
import { AttachmentsService } from './attachments/service';
import { openDatabase } from './db/connection';
import { listProjects } from './db/projects';
import { DocsService } from './docs/service';
import { ensurePersonalProject } from './domain/projects';
import { createEngines } from './engine';
import { AgentRegistry } from './engine/acp/registry';
import { FilesService } from './files/service';
import { startServer } from './http/server';
import { acquireLock, writeDaemonInfo } from './instance';
import { announceAgentsChanged } from './providers/announce';
import { ModelCatalog } from './providers/models';
import { ProvidersService } from './providers/service';
import { RunDriver } from './runs/driver';
import { ChatQueue } from './runs/queue';
import { RunService } from './runs/service';
import { toolsFor } from './runs/tools';
import { Wakeups } from './runs/wake';
import { SkillsService } from './skills/service';
import { Store } from './store';

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
    heartbeatMs?: number;
    /** Called once the daemon has stopped because a client asked (`POST /v1/shutdown`); the entry point exits the process here. */
    onShutdown?: () => void;
}

/** Wires everything and starts serving. Throws `AlreadyRunningError` when another daemon owns the data directory. */
export async function startDaemon(config: Config, options: DaemonOptions = {}): Promise<Daemon> {
    const releaseLock = acquireLock(config.dataDir);

    try {
        const startedAt = Date.now();
        const store = new Store(openDatabase(join(config.dataDir, 'clowdy.db')));
        // Before the engines: runs read `config.systemSkillsDir` when they start.
        const skills = new SkillsService(store, config);
        const agents = options.agents ?? new AgentRegistry({ dataDir: config.dataDir });
        const created = options.engines ? undefined : createEngines(config, agents);
        const engines = options.engines ?? created as EngineRegistry;

        if (!engines.has(config.engine)) {
            throw new Error(`CLOWDY_ENGINE=${ config.engine } is not an agent this daemon knows: pick fake, claude, codex, cursor, opencode, gemini, copilot, grok, omp, hermes, or the id of a custom agent`);
        }

        const runs = new RunService(store, config, engines);
        const driver: RunDriver = new RunDriver({ store, config, runs, engines, tools: (run, mode) => toolsFor({ store, runs, driver }, run, mode), compactCommand: engine => agents.compactCommand(engine) });
        const wakes = new Wakeups(store, runs, driver, config.timings.wakeWindowMs);
        const docs = new DocsService(store);
        const attachments = new AttachmentsService(store, config.dataDir);
        // Before the recovery: a turn the restart interrupted holds its chat's queue.
        const queue = new ChatQueue({ store, runs, driver, attachments });
        const providers = options.providers ?? new ProvidersService({
            registry: agents,
            announce: () => announceAgentsChanged(store),
        });
        const services: Services = { config, store, runs, driver, queue, docs, files: new FilesService(), attachments, skills, agents, providers, models: options.models ?? new ModelCatalog({ registry: agents }) };

        await runs.recover();
        attachments.sweep();
        // Before the watchers, so the personal space is watched like any project.
        ensurePersonalProject(store, config);
        docs.watchExisting(listProjects(store.db));
        skills.watchFolders(listProjects(store.db));
        driver.resumeWaiting();
        wakes.resumePending();
        queue.resumePending();

        let stopping: Promise<void> | undefined;

        const stop = () => stopping ??= (async () => {
            await server.stop(true);
            wakes.stop();
            await driver.stop();
            created?.stop();
            providers.stop();
            services.models.stop();
            docs.stop();
            skills.stop();
            store.db.close();
            removeInfo();
            releaseLock();
        })();
        const server = startServer({
            services,
            version: VERSION,
            startedAt,
            heartbeatMs: options.heartbeatMs,
            // Answer first: stopping closes the connection this request came in on.
            shutdown: () => void setTimeout(() => void stop().then(options.onShutdown), 50),
        });
        const info: DaemonInfo = { pid: process.pid, port: server.port as number, token: config.token, protocol: PROTOCOL_VERSION, startedAt };
        const removeInfo = writeDaemonInfo(config.dataDir, info);

        return { info, services, stop };
    }
    catch (error) {
        releaseLock();
        throw error;
    }
}
