import { afterEach, describe, expect, test, vi } from 'vitest';

import { loadConfig } from '../../../daemon/src/config';
import { currentContext } from './daemon';

describe('the data folder', () => {
    afterEach(() => vi.unstubAllEnvs());

    // The app reads the daemon's `daemon.json` from the folder it computes; the daemon writes it to the folder it computes.
    test.each([
        ['the default', {}],
        ['the dev profile', { CLOWDY_PROFILE: 'dev' }],
        ['an explicit folder', { CLOWDY_DATA_DIR: '/tmp/clowdy-elsewhere' }],
        ['an explicit folder in the dev profile', { CLOWDY_DATA_DIR: '/tmp/clowdy-elsewhere', CLOWDY_PROFILE: 'dev' }],
    ])('the app and the daemon agree on %s', (_name, env) => {
        vi.stubEnv('CLOWDY_DATA_DIR', '');
        vi.stubEnv('CLOWDY_PROFILE', '');

        for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

        expect(currentContext().dataDir).toBe(loadConfig(process.env).dataDir);
    });
});
