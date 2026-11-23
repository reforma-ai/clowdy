import { PROTOCOL_VERSION } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import { createTransport } from './config';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

describe('HttpTransport.getHealth', () => {
    it('asks the daemon about itself and returns what it said', async () => {
        const urls: string[] = [];
        const health = { ok: true, protocol: PROTOCOL_VERSION, version: '0.1.1', pid: 4242, startedAt: 1_700_000_000_000 };
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify(health), { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        expect(await transport.getHealth()).toEqual(health);
        expect(urls).toEqual(['http://127.0.0.1:4310/v1/health']);
    });

    it('fails when the daemon refuses', async () => {
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch });

        await expect(transport.getHealth()).rejects.toMatchObject({ status: 500 });
    });
});

describe('getHealth without a daemon', () => {
    it('answers for the fixtures with the protocol of this build', async () => {
        const health = await new FixtureTransport().getHealth();

        expect(health).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
        expect(health.version).toBeTruthy();
    });

    it('fails when none is configured, as every other read does', async () => {
        await expect(createTransport({ kind: 'none' }).getHealth()).rejects.toThrow('No daemon is configured');
    });
});
