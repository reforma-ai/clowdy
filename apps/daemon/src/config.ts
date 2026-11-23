import { daemonDataDir, type EngineId } from '@clowdy/protocol';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export interface Config {
    dataDir: string;
    /** Parent folder of the new folder `project.add` makes for a project without folders: `~/Clowdy/projects`. */
    projectsDir: string;
    /** The folder of the personal space: `~/Clowdy/Personal`. */
    personalDir: string;
    /** Parent folder of the worktrees Clowdy makes for chats: `~/Clowdy/workspaces`, below it `<project-slug>/<chat-id8>/<folder-name>`. */
    workspacesDir: string;
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
    /** How many levels a thread tree has at most, the chat the person made included: 3 is the chat, its threads and their threads. */
    maxThreadDepth: number;
    /** Threads of one chat (its direct ones) whose work is not over, at most; a thread whose run has not been made yet counts. */
    maxActiveThreads: number;
    /** Threads one chat may start over its life (its direct ones), finished ones included. */
    maxThreads: number;
    timings: Timings;
    /** Multiplier of the fake engine's delays; 0 removes them (tests). */
    fakeSpeed: number;
    /**
     * The ripgrep the file search runs (`CLOWDY_RG`): the absolute path of an `rg` executable, which the desktop app gives a packaged run;
     * `false` (`CLOWDY_RG=off`) for none, so the daemon scans the files itself; absent, the `rg` found on the PATH.
     */
    ripgrep?: string | false;
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
    /** Cancelling aborts the engine, then sends SIGTERM to its process group after this long, then SIGKILL after it again. */
    killGraceMs: number;
    /** First delay before a run retries after a transient engine error; it doubles up to five minutes. */
    retryBaseMs: number;
    /** After a subscription reset an engine resumes at a random moment within this long, so its runs do not all hit the limit together. */
    pauseJitterMs: number;
    /** A parent is told of its threads that stopped this long after the first of them: those that stop meanwhile join the same message. */
    noticeWindowMs: number;
    /** The setup command of a new worktree (`Prepare workspace`) is stopped, with everything it started, after this long. */
    setupMs: number;
}

export const DEFAULT_TIMINGS: Timings = { killGraceMs: 5000, retryBaseMs: 5000, pauseJitterMs: 30_000, noticeWindowMs: 2000, setupMs: 10 * 60_000 };

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

function ripgrepFrom(env: Env): Config['ripgrep'] {
    const raw = env.CLOWDY_RG?.trim();

    if (!raw) {
        return undefined;
    }

    if (raw === 'off') {
        return false;
    }

    if (!isAbsolute(raw)) {
        throw new ConfigError(`CLOWDY_RG must be the absolute path of an rg executable, or off, got "${ raw }"`);
    }

    return raw;
}

export function loadConfig(env: Env = process.env, platform: NodeJS.Platform = process.platform): Config {
    // Any agent id: whether the daemon can run it is decided at start, against the agents it finds.
    const engine = (env.CLOWDY_ENGINE || 'fake').trim();

    return {
        dataDir: daemonDataDir({ platform, home: homedir(), env }),
        projectsDir: env.CLOWDY_PROJECTS_DIR || join(homedir(), 'Clowdy', 'projects'),
        personalDir: env.CLOWDY_PERSONAL_DIR || join(homedir(), 'Clowdy', 'Personal'),
        workspacesDir: env.CLOWDY_WORKSPACES_DIR || join(homedir(), 'Clowdy', 'workspaces'),
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
        maxThreadDepth: numberFrom(env, 'CLOWDY_MAX_THREAD_DEPTH', 3, isCap, 'a positive integer'),
        maxActiveThreads: numberFrom(env, 'CLOWDY_MAX_ACTIVE_THREADS', 30, isCap, 'a positive integer'),
        maxThreads: numberFrom(env, 'CLOWDY_MAX_THREADS', 300, isCap, 'a positive integer'),
        timings: {
            ...DEFAULT_TIMINGS,
            noticeWindowMs: numberFrom(env, 'CLOWDY_THREAD_NOTICE_WINDOW_MS', DEFAULT_TIMINGS.noticeWindowMs, v => Number.isInteger(v) && v >= 0, 'a whole number of milliseconds, 0 or more'),
        },
        fakeSpeed: numberFrom(env, 'CLOWDY_FAKE_SPEED', 1, v => v >= 0, 'a number of at least 0'),
        ripgrep: ripgrepFrom(env),
        systemSkillsSource: env.CLOWDY_SYSTEM_SKILLS_DIR || undefined,
        userSkillRoots: env.CLOWDY_USER_SKILLS_DIRS ? env.CLOWDY_USER_SKILLS_DIRS.split(delimiter).filter(Boolean) : [join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills')],
    };
}
