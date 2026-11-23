import { describe, expect, it } from 'vitest';

import { FIXTURE_PROJECT_ID } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

describe('FixtureTransport.fileSystem', () => {
    it("is the folder's files, with what a few of them hold, and what the person writes stays for the session", async () => {
        const transport = new FixtureTransport();
        const files = transport.fileSystem(FIXTURE_PROJECT_ID, 'fld_car_rental');
        const paths = (await files.list()).filter(entry => entry.kind === 'file').map(entry => entry.path);

        expect(paths).toEqual(
            expect.arrayContaining(['README.md', 'package.json', 'src/booking/price.ts', '.gitignore', 'tsconfig.json'])
        );
        expect(await files.read('README.md')).toMatchObject({
            kind: 'text',
            text: expect.stringContaining('# Car Rental'),
        });

        await files.write('notes.md', 'hello');

        expect(await transport.fileSystem(FIXTURE_PROJECT_ID, 'fld_car_rental').read('notes.md')).toMatchObject({
            text: 'hello',
        });
    });

    it('refuses a folder the project does not have', () => {
        expect(() => new FixtureTransport().fileSystem(FIXTURE_PROJECT_ID, 'fld_nope')).toThrow('does not exist');
    });
});

describe('HttpTransport.fileSystem', () => {
    it('asks the daemon at the address it has now, so a replaced daemon is found without making the file system again', async () => {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            urls.push(`${String(input)} ${(init?.headers as Record<string, string>).authorization}`);

            return new Response('[]');
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 'a', fetch: fetchImpl });
        const files = transport.fileSystem('prj 1', 'fld_1');

        await files.list();
        transport.setAddress({ url: 'http://127.0.0.1:4311', token: 'b' });
        await files.list();

        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/projects/prj%201/fs/list?folderId=fld_1&path= Bearer a',
            'http://127.0.0.1:4311/v1/projects/prj%201/fs/list?folderId=fld_1&path= Bearer b',
        ]);
    });
});
