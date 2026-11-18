import { daemonDataDir } from '@clowdy/protocol';
import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';

import { ConfigError, loadConfig } from '../src/config';

describe('config', () => {
    test('defaults: fake engine, random port and token, 8 runs, normal speed', () => {
        const config = loadConfig({}, 'linux');

        expect(config).toMatchObject({ port: 0, engine: 'fake', maxRuns: 8, fakeSpeed: 1 });
        expect(config.token).toMatch(/^[0-9a-f]{64}$/);
        expect(loadConfig({}, 'linux').token).not.toBe(config.token);
    });

    test('the data dir comes from the shared protocol function, so the desktop app finds the same folder', () => {
        for (const platform of ['darwin', 'win32', 'linux'] as const) {
            for (const env of [{}, { CLOWDY_PROFILE: 'dev' }, { LOCALAPPDATA: 'D:\\Local' }]) {
                expect(loadConfig(env, platform).dataDir).toBe(daemonDataDir({ platform, home: homedir(), env }));
            }
        }
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
