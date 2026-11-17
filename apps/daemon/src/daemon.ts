import { PROTOCOL_VERSION } from '@clowdy/protocol';
import { join } from 'node:path';

import pkg from '../package.json';
import { openDatabase } from './db/connection';
import { listProjects } from './db/projects';
import { DocsService } from './docs/service';
import { createEngines } from './engine';
import { startServer } from './http/server';
import { acquireLock, writeDaemonInfo } from './instance';
import { RunDriver } from './runs/driver';
import { RunService } from './runs/service';
import { toolsFor } from './runs/tools';
import { Wakeups } from './runs/wake';
import { SkillsService } from './skills/service';
import { Store } from './store';

import type { DaemonInfo, EngineId } from '@clowdy/protocol';
import type { Services } from './commands';
import type { Config } from './config';
import type { AgentEngine } from './engine/types';

export interface Daemon {
    info: DaemonInfo;
    services: Services;
    /** Aborts live work, closes the server and the database, removes `daemon.json` and the lock. */
    stop(): Promise<void>;
}

export interface DaemonOptions {
    /** Replaces the engine registry; tests use it to script engines. */
    engines?: ReadonlyMap<EngineId, AgentEngine>;
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
        // Before the engines: they read `config.systemSkillsDir` and `config.extraPluginDirs` when a run starts.
        const skills = new SkillsService(store, config);
        const engines = options.engines ?? createEngines(config);

        if (!engines.has(config.engine)) {
            throw new Error(`CLOWDY_ENGINE=${ config.engine } is not available in this daemon`);
        }

        const runs = new RunService(store, config, engines);
        const driver: RunDriver = new RunDriver({ store, config, runs, engines, tools: (run, mode) => toolsFor({ store, runs, driver }, run, mode) });
        const wakes = new Wakeups(store, runs, driver, config.timings.wakeWindowMs);
        const docs = new DocsService(store);
        const services: Services = { config, store, runs, driver, docs, skills };

        await runs.recover();
        docs.watchExisting(listProjects(store.db));
        skills.watchFolders(listProjects(store.db));
        driver.resumeWaiting();
        wakes.resumePending();

        let stopping: Promise<void> | undefined;

        const stop = () => stopping ??= (async () => {
            await server.stop(true);
            wakes.stop();
            await driver.stop();
            docs.stop();
            skills.stop();
            store.db.close();
            removeInfo();
            releaseLock();
        })();
        const server = startServer({
            services,
            version: pkg.version,
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
