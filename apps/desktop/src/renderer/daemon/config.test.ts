import { describe, expect, it } from 'vitest';

import { createTransport, resolveDaemonConfig } from './config';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

describe('resolveDaemonConfig', () => {
    const bridge = { url: 'http://127.0.0.1:1', token: 'from-bridge' };

    it('prefers what the desktop shell provides over the page URL', () => {
        expect(resolveDaemonConfig('?daemon=http://x&token=y&fixtures', bridge)).toEqual({ kind: 'daemon', ...bridge });
    });

    it('reads the daemon and token from the page URL', () => {
        expect(resolveDaemonConfig('?daemon=http://127.0.0.1:4310&token=abc&fixtures')).toEqual({ kind: 'daemon', url: 'http://127.0.0.1:4310', token: 'abc' });
    });

    it('uses fixtures when asked, with or without the timed events', () => {
        expect(resolveDaemonConfig('?fixtures=1')).toEqual({ kind: 'fixtures', timeline: true });
        expect(resolveDaemonConfig('?fixtures')).toEqual({ kind: 'fixtures', timeline: true });
        expect(resolveDaemonConfig('?fixtures=static')).toEqual({ kind: 'fixtures', timeline: false });
    });

    it('has nothing otherwise', () => {
        expect(resolveDaemonConfig('')).toEqual({ kind: 'none' });
        expect(resolveDaemonConfig('?other=1')).toEqual({ kind: 'none' });
    });
});

describe('createTransport', () => {
    it('makes the transport the config names', () => {
        expect(createTransport({ kind: 'daemon', url: 'http://d', token: 't' })).toBeInstanceOf(HttpTransport);
        expect(createTransport({ kind: 'fixtures', timeline: false })).toBeInstanceOf(FixtureTransport);
    });

    it('makes a transport that cannot reach anything when there is no config', async () => {
        const transport = createTransport({ kind: 'none' });

        await expect(transport.getRootSnapshot()).rejects.toThrow('No daemon is configured');
        await expect(transport.command({ type: 'run.cancel', runId: 'r' })).rejects.toThrow('No daemon is configured');
    });
});
