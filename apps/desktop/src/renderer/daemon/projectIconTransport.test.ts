import { describe, expect, it } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

const URL_BASE = 'http://127.0.0.1:4310';

describe('HttpTransport.getProjectIcon', () => {
    it('gives the icon of the main folder as a blob, and nothing when the daemon finds none', async () => {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return String(input).includes('none')
                ? new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'None has no icon in its main folder' } }), { status: 404 })
                : new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: URL_BASE, token: 't', fetch: fetchImpl });
        const icon = await transport.getProjectIcon('prj 1');

        expect(await icon?.text()).toBe('<svg/>');
        expect(icon?.type).toBe('image/svg+xml');
        expect(await transport.getProjectIcon('none')).toBeUndefined();
        expect(urls).toEqual([`${ URL_BASE }/v1/projects/prj%201/icon`, `${ URL_BASE }/v1/projects/none/icon`]);
    });

    it('rejects when the daemon fails otherwise', async () => {
        const transport = new HttpTransport({ url: URL_BASE, token: 't', fetch: (async () => new Response('', { status: 500 })) as typeof fetch });

        await expect(transport.getProjectIcon('p')).rejects.toMatchObject({ status: 500 });
    });
});

describe('FixtureTransport.getProjectIcon', () => {
    it('gives Car Rental its favicon, and nothing for a project without one or for the personal space', async () => {
        const transport = new FixtureTransport();

        expect((await transport.getProjectIcon(FIXTURE_PROJECT_ID))?.type).toBe('image/svg+xml');
        expect(await transport.getProjectIcon(FIXTURE_EMPTY_PROJECT_ID)).toBeUndefined();
        expect(await transport.getProjectIcon(FIXTURE_PERSONAL_PROJECT_ID)).toBeUndefined();
    });
});
