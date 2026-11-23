import { daemonDataDir } from '@clowdy/protocol';
import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig } from '../src/config';

describe('config', () => {
    test('defaults: fake engine, random port and token, 8 runs, normal speed', () => {
        const config = loadConfig({}, 'linux');

        expect(config).toMatchObject({ port: 0, engine: 'fake', maxRuns: 8, fakeSpeed: 1 });
        expect(config.token).toMatch(/^[0-9a-f]{64}$/);
        expect(loadConfig({}, 'linux').token).not.toBe(config.token);
    });

    test('a project without folders gets a new folder under ~/Clowdy/projects, or CLOWDY_PROJECTS_DIR', () => {
        expect(loadConfig({}, 'linux').projectsDir).toBe(join(homedir(), 'Clowdy', 'projects'));
        expect(loadConfig({ CLOWDY_PROJECTS_DIR: '/work' }, 'linux').projectsDir).toBe('/work');
    });

    test('the personal space is ~/Clowdy/Personal, or CLOWDY_PERSONAL_DIR', () => {
        expect(loadConfig({}, 'linux').personalDir).toBe(join(homedir(), 'Clowdy', 'Personal'));
        expect(loadConfig({ CLOWDY_PERSONAL_DIR: '/mine' }, 'linux').personalDir).toBe('/mine');
    });

    test('the worktrees of chats go under ~/Clowdy/workspaces, or CLOWDY_WORKSPACES_DIR', () => {
        expect(loadConfig({}, 'linux').workspacesDir).toBe(join(homedir(), 'Clowdy', 'workspaces'));
        expect(loadConfig({ CLOWDY_WORKSPACES_DIR: '/trees' }, 'linux').workspacesDir).toBe('/trees');
    });

    test('the data dir comes from the shared protocol function, so the desktop app finds the same folder', () => {
        for (const platform of ['darwin', 'win32', 'linux'] as const) {
            for (const env of [{}, { CLOWDY_PROFILE: 'dev' }, { LOCALAPPDATA: 'D:\\Local' }]) {
                expect(loadConfig(env, platform).dataDir).toBe(daemonDataDir({ platform, home: homedir(), env }));
            }
        }
    });

    test('threads: three levels, 30 at work and 300 over the life of a chat, unless the environment says otherwise', () => {
        expect(loadConfig({}, 'linux')).toMatchObject({ maxThreadDepth: 3, maxActiveThreads: 30, maxThreads: 300 });
        expect(loadConfig({ CLOWDY_MAX_THREAD_DEPTH: '2', CLOWDY_MAX_ACTIVE_THREADS: '5', CLOWDY_MAX_THREADS: '50' }, 'linux')).toMatchObject({ maxThreadDepth: 2, maxActiveThreads: 5, maxThreads: 50 });
        expect(() => loadConfig({ CLOWDY_MAX_THREAD_DEPTH: '0' })).toThrow(/CLOWDY_MAX_THREAD_DEPTH/);
        expect(() => loadConfig({ CLOWDY_MAX_ACTIVE_THREADS: '1.5' })).toThrow(/CLOWDY_MAX_ACTIVE_THREADS/);
        expect(() => loadConfig({ CLOWDY_MAX_THREADS: 'many' })).toThrow(/CLOWDY_MAX_THREADS/);
    });

    test('a parent hears of its threads that stopped 2 s after the first one, unless the environment says otherwise; the other timings keep their defaults', () => {
        expect(loadConfig({}, 'linux').timings).toEqual({ killGraceMs: 5000, retryBaseMs: 5000, pauseJitterMs: 30_000, noticeWindowMs: 2000, setupMs: 600_000 });
        expect(loadConfig({ CLOWDY_THREAD_NOTICE_WINDOW_MS: '0' }, 'linux').timings.noticeWindowMs).toBe(0);
        expect(loadConfig({ CLOWDY_THREAD_NOTICE_WINDOW_MS: '500' }, 'linux').timings).toMatchObject({ noticeWindowMs: 500, killGraceMs: 5000 });
        expect(() => loadConfig({ CLOWDY_THREAD_NOTICE_WINDOW_MS: '-1' })).toThrow(/CLOWDY_THREAD_NOTICE_WINDOW_MS/);
        expect(() => loadConfig({ CLOWDY_THREAD_NOTICE_WINDOW_MS: '1.5' })).toThrow(/CLOWDY_THREAD_NOTICE_WINDOW_MS/);
    });

    test('environment variables override the defaults', () => {
        expect(loadConfig({
            CLOWDY_DATA_DIR: '/data',
            CLOWDY_PORT: '47831',
            CLOWDY_TOKEN: 'devtoken',
            CLOWDY_ENGINE: 'claude',
            CLOWDY_MAX_RUNS: '3',
            CLOWDY_FAKE_SPEED: '0',
        })).toMatchObject({ dataDir: '/data', port: 47831, token: 'devtoken', engine: 'claude', maxRuns: 3, fakeSpeed: 0 });
    });

    test('any engine id is accepted: the daemon checks it against its agents at start', () => {
        expect(loadConfig({ CLOWDY_ENGINE: ' cursor ' }).engine).toBe('cursor');
    });

    test('CORS origins: none by default, a comma-separated list on request', () => {
        expect(loadConfig({}, 'linux').corsOrigins).toEqual([]);
        expect(loadConfig({ CLOWDY_CORS_ORIGINS: ' http://127.0.0.1:5300 , ,http://localhost:5400' }, 'linux').corsOrigins).toEqual(['http://127.0.0.1:5300', 'http://localhost:5400']);
    });

    test('invalid values name the variable', () => {
        expect(() => loadConfig({ CLOWDY_PORT: 'abc' })).toThrow(ConfigError);
        expect(() => loadConfig({ CLOWDY_PORT: '70000' })).toThrow(/CLOWDY_PORT/);
        expect(() => loadConfig({ CLOWDY_MAX_RUNS: '0' })).toThrow(/CLOWDY_MAX_RUNS/);
        expect(() => loadConfig({ CLOWDY_FAKE_SPEED: '-1' })).toThrow(/CLOWDY_FAKE_SPEED/);
        expect(() => loadConfig({ CLOWDY_MAX_RUNS_AGENT: '0' })).toThrow(/CLOWDY_MAX_RUNS_AGENT/);
    });
});
