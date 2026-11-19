import { describe, expect, it } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

describe('HttpTransport.getProjectFiles', () => {
    it('asks for the project\'s files with the words typed and the limit, when there is one', async () => {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify([{ folderId: 'fld_1', path: 'src/a b.ts' }]), { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        expect(await transport.getProjectFiles('prj 1', 'a b&c', 20)).toEqual([{ folderId: 'fld_1', path: 'src/a b.ts' }]);
        await transport.getProjectFiles('prj 1', '');

        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/projects/prj%201/files?query=a+b%26c&limit=20',
            'http://127.0.0.1:4310/v1/projects/prj%201/files?query=',
        ]);
    });
});

describe('FixtureTransport.getProjectFiles', () => {
    it('lists the files that hold every word, up to the limit, and none for a project without files', async () => {
        const transport = new FixtureTransport();

        expect(await transport.getProjectFiles(FIXTURE_PROJECT_ID, 'price booking')).toEqual([
            { folderId: 'fld_car_rental', path: 'src/booking/price.ts' },
            { folderId: 'fld_car_rental', path: 'src/booking/price.test.ts' },
        ]);
        expect(await transport.getProjectFiles(FIXTURE_PROJECT_ID, '', 3)).toHaveLength(3);
        expect(await transport.getProjectFiles(FIXTURE_EMPTY_PROJECT_ID, '')).toEqual([]);
    });
});
