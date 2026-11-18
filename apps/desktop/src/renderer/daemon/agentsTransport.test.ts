import { describe, expect, it } from 'vitest';

import { HttpTransport } from './httpTransport';

describe('HttpTransport.getAgents', () => {
    it('asks for the agents and returns the list as it came', async () => {
        const urls: string[] = [];
        const list = [{ id: 'claude', name: 'Claude Code' }];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify(list), { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        expect(await transport.getAgents()).toEqual(list);
        expect(urls).toEqual(['http://127.0.0.1:4310/v1/agents']);
    });

    it('fails when the daemon refuses', async () => {
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch });

        await expect(transport.getAgents()).rejects.toMatchObject({ status: 500 });
    });
});
