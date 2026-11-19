import { daemonDataDir, type EngineId } from '@clowdy/protocol';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface Config {
    dataDir: string;
    /** Parent folder of the new folder `project.add` makes for a project without folders. */
    projectsDir: string;
    /** 0 picks a random free port. */
    port: number;
    token: string;
    /** Origins besides `app://clowdy` that may call the API from a browser page, for development tools: a Vite dev server, say. */
    corsOrigins: string[];
    engine: EngineId;
    /** Global cap of runs in the `running` state. */
    maxRuns: number;
    /** Cap of runs in `running` per engine, on top of `maxRuns`. Subscription limits lower it at run time. */
    engineCaps: Record<EngineId, number>;
    /** The cap of an engine that has no entry in `engineCaps`: any agent the user adds. */
    defaultEngineCap: number;
    /** Hard cap of live engine processes: a guard against runaway sessions, far above the run caps. */
    maxProcesses: number;
    /** Runs one orchestrator may have unfinished at once (queued, running, waiting or blocked). The run caps decide how many really run. */
    maxActiveChildren: number;
    /** Runs one orchestrator may start with `run_spawn` over the life of its chat, finished ones included: a guard against a spawn loop. */
    maxChildren: number;
    timings: Timings;
    /** How the daemon answers an agent's permission requests: nobody is at a terminal, so it decides, the same for every agent. */
    agentPermissions: 'allow' | 'reject';
    /** Multiplier of the fake engine's delays; 0 removes them (tests). */
    fakeSpeed: number;
    /** The system skills plugin folder (manifest and `skills/`) to copy into the data folder; the repository's `packages/system-skills` when absent. */
    systemSkillsSource?: string;
    /** The user's skill folders, weakest first (a skill in a later one hides the same name in an earlier one). Absent means none. */
    userSkillRoots?: string[];
    /**
     * Set by the daemon at start: the materialized system skills folder, `<dataDir>/system-skills/<hash>`.
     * Every run's system prompt inlines the entry skill from it and names it for the rest, so it is read when a run starts.
     */
    systemSkillsDir?: string;
    /**
     * Set by the daemon and replaced when the user's skills change: the `user` plugin folder that links the enabled user
     * skills, or nothing. No engine reads it since Claude Code runs through its ACP adapter, which loads the user's own skills.
     */
    extraPluginDirs?: string[];
}

/** Delays of the run runtime, in milliseconds. Tests shrink them. */
export interface Timings {
    /** A parent waits this long after a child finished, so children finishing together arrive in one message. */
    wakeWindowMs: number;
    /** Cancelling aborts the engine, then sends SIGTERM to its process group after this long, then SIGKILL after it again. */
    killGraceMs: number;
    /** First delay before a run retries after a transient engine error; it doubles up to five minutes. */
    retryBaseMs: number;
    /** After a subscription reset an engine resumes at a random moment within this long, so its runs do not all hit the limit together. */
    pauseJitterMs: number;
}

export const DEFAULT_TIMINGS: Timings = { wakeWindowMs: 10_000, killGraceMs: 5000, retryBaseMs: 5000, pauseJitterMs: 30_000 };

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function numberFrom(env: Env, name: string, fallback: number, check: (value: number) => boolean, expected: string): number {
    const raw = env[name];

    if (raw === undefined || raw === '') {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isFinite(value) || !check(value)) {
        throw new ConfigError(`${ name } must be ${ expected }, got "${ raw }"`);
    }

    return value;
}

const isCap = (value: number) => Number.isInteger(value) && value >= 1;

function permissions(env: Env): Config['agentPermissions'] {
    const raw = env.CLOWDY_AGENT_PERMISSIONS || 'allow';

    if (raw !== 'allow' && raw !== 'reject') {
        throw new ConfigError(`CLOWDY_AGENT_PERMISSIONS must be allow or reject, got "${ raw }"`);
    }

    return raw;
}

export function loadConfig(env: Env = process.env, platform: NodeJS.Platform = process.platform): Config {
    // Any agent id: whether the daemon can run it is decided at start, against the agents it finds.
    const engine = (env.CLOWDY_ENGINE || 'fake').trim();

    return {
        dataDir: daemonDataDir({ platform, home: homedir(), env }),
        projectsDir: env.CLOWDY_PROJECTS_DIR || join(homedir(), 'Clowdy'),
        port: numberFrom(env, 'CLOWDY_PORT', 0, v => Number.isInteger(v) && v >= 0 && v <= 65535, 'a port between 0 and 65535'),
        token: env.CLOWDY_TOKEN || randomBytes(32).toString('hex'),
        corsOrigins: (env.CLOWDY_CORS_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean),
        engine,
        maxRuns: numberFrom(env, 'CLOWDY_MAX_RUNS', 8, v => Number.isInteger(v) && v >= 1, 'a positive integer'),
        engineCaps: {
            claude: numberFrom(env, 'CLOWDY_MAX_RUNS_CLAUDE', 6, isCap, 'a positive integer'),
            codex: numberFrom(env, 'CLOWDY_MAX_RUNS_CODEX', 4, isCap, 'a positive integer'),
            fake: numberFrom(env, 'CLOWDY_MAX_RUNS_FAKE', 1000, isCap, 'a positive integer'),
        },
        defaultEngineCap: numberFrom(env, 'CLOWDY_MAX_RUNS_AGENT', 4, isCap, 'a positive integer'),
        maxProcesses: numberFrom(env, 'CLOWDY_MAX_PROCESSES', 24, isCap, 'a positive integer'),
        maxActiveChildren: numberFrom(env, 'CLOWDY_MAX_ACTIVE_CHILDREN', 300, isCap, 'a positive integer'),
        maxChildren: numberFrom(env, 'CLOWDY_MAX_CHILDREN', 3000, isCap, 'a positive integer'),
        // Each wake-up is a resumed orchestrator turn that costs quota, so children that finish within this window share one.
        timings: { ...DEFAULT_TIMINGS, wakeWindowMs: numberFrom(env, 'CLOWDY_WAKE_WINDOW_MS', DEFAULT_TIMINGS.wakeWindowMs, v => v >= 0, 'a number of milliseconds') },
        agentPermissions: permissions(env),
        fakeSpeed: numberFrom(env, 'CLOWDY_FAKE_SPEED', 1, v => v >= 0, 'a number of at least 0'),
        systemSkillsSource: env.CLOWDY_SYSTEM_SKILLS_DIR || undefined,
        userSkillRoots: env.CLOWDY_USER_SKILLS_DIRS ? env.CLOWDY_USER_SKILLS_DIRS.split(delimiter).filter(Boolean) : [join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills')],
    };
}
