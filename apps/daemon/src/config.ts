import { daemonDataDir, type EngineId } from '@clowdy/protocol';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface Config {
    dataDir: string;
    /** Parent folder of projects created by `project.create` when no path is given. */
    projectsDir: string;
    /** 0 picks a random free port. */
    port: number;
    token: string;
    engine: EngineId;
    /** Global cap of runs in the `running` state. */
    maxRuns: number;
    /** Cap of runs in `running` per engine, on top of `maxRuns`. Subscription limits lower it at run time. */
    engineCaps: Record<EngineId, number>;
    /** Hard cap of live engine processes: a guard against runaway sessions, far above the run caps. */
    maxProcesses: number;
    timings: Timings;
    /** Multiplier of the fake engine's delays; 0 removes them (tests). */
    fakeSpeed: number;
    /** The system skills plugin folder (manifest and `skills/`) to copy into the data folder; the repository's `packages/system-skills` when absent. */
    systemSkillsSource?: string;
    /** The user's skill folders, weakest first (a skill in a later one hides the same name in an earlier one). Absent means none. */
    userSkillRoots?: string[];
    /**
     * Set by the daemon at start: the materialized system skills plugin, `<dataDir>/system-skills/<hash>`.
     * Engines load it as a plugin (`clowdy:<skill>`) in every run, so they must read this key when a run starts.
     */
    systemSkillsDir?: string;
    /**
     * Set by the daemon and replaced when the user's skills change: plugin folders every run loads besides the system
     * one. Today it holds the `user` plugin that links the enabled user skills, or nothing. Read it when a run starts.
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

export const DEFAULT_TIMINGS: Timings = { wakeWindowMs: 2000, killGraceMs: 5000, retryBaseMs: 5000, pauseJitterMs: 30_000 };

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

const ENGINES: readonly EngineId[] = ['claude', 'codex', 'fake'];

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

export function loadConfig(env: Env = process.env, platform: NodeJS.Platform = process.platform): Config {
    const engine = env.CLOWDY_ENGINE || 'fake';

    if (!ENGINES.includes(engine as EngineId)) {
        throw new ConfigError(`CLOWDY_ENGINE must be one of ${ ENGINES.join(', ') }, got "${ engine }"`);
    }

    return {
        dataDir: daemonDataDir({ platform, home: homedir(), env }),
        projectsDir: env.CLOWDY_PROJECTS_DIR || join(homedir(), 'Clowdy'),
        port: numberFrom(env, 'CLOWDY_PORT', 0, v => Number.isInteger(v) && v >= 0 && v <= 65535, 'a port between 0 and 65535'),
        token: env.CLOWDY_TOKEN || randomBytes(32).toString('hex'),
        engine: engine as EngineId,
        maxRuns: numberFrom(env, 'CLOWDY_MAX_RUNS', 8, v => Number.isInteger(v) && v >= 1, 'a positive integer'),
        engineCaps: {
            claude: numberFrom(env, 'CLOWDY_MAX_RUNS_CLAUDE', 6, isCap, 'a positive integer'),
            codex: numberFrom(env, 'CLOWDY_MAX_RUNS_CODEX', 4, isCap, 'a positive integer'),
            fake: numberFrom(env, 'CLOWDY_MAX_RUNS_FAKE', 1000, isCap, 'a positive integer'),
        },
        maxProcesses: numberFrom(env, 'CLOWDY_MAX_PROCESSES', 24, isCap, 'a positive integer'),
        timings: DEFAULT_TIMINGS,
        fakeSpeed: numberFrom(env, 'CLOWDY_FAKE_SPEED', 1, v => v >= 0, 'a number of at least 0'),
        systemSkillsSource: env.CLOWDY_SYSTEM_SKILLS_DIR || undefined,
        userSkillRoots: env.CLOWDY_USER_SKILLS_DIRS ? env.CLOWDY_USER_SKILLS_DIRS.split(delimiter).filter(Boolean) : [join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills')],
    };
}
