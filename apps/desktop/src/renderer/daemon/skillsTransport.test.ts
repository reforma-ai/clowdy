import { describe, expect, it } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

import type { ClowdyEvent } from '@clowdy/protocol';

describe('HttpTransport.getSkills', () => {
    it('asks for the catalog, with the project when there is one', async () => {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify({ entries: [], tokens: 0, warnings: [] }), { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await transport.getSkills();
        await transport.getSkills('prj 1');

        expect(urls).toEqual(['http://127.0.0.1:4310/v1/skills', 'http://127.0.0.1:4310/v1/skills?projectId=prj%201']);
    });

    it('fails when the daemon refuses', async () => {
        const fetchImpl = (async () => new Response('{}', { status: 404 })) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await expect(transport.getSkills('nope')).rejects.toMatchObject({ status: 404 });
    });
});

describe('FixtureTransport skills', () => {
    it('lists system and user skills for everyone and project skills only for their project', async () => {
        const transport = new FixtureTransport();
        const global = await transport.getSkills();
        const car = await transport.getSkills(FIXTURE_PROJECT_ID);
        const other = await transport.getSkills(FIXTURE_EMPTY_PROJECT_ID);

        expect(global.entries.filter(entry => entry.source === 'project')).toEqual([]);
        expect(car.entries.filter(entry => entry.source === 'project').map(entry => entry.name)).toEqual([
            'booking-rules',
            'fleet-import',
        ]);
        expect(other.entries).toEqual(global.entries);
        expect(car.entries.every(entry => !('projectId' in entry))).toBe(true);
        await expect(transport.getSkills('nope')).rejects.toMatchObject({ status: 404 });
    });

    it('counts only the enabled skills in the cost', async () => {
        const { entries, tokens } = await new FixtureTransport().getSkills();
        const enabled = entries.filter(entry => entry.enabled);

        expect(entries.some(entry => !entry.enabled)).toBe(true);
        expect(tokens).toBe(enabled.reduce((sum, entry) => sum + entry.tokens, 0));
    });

    it('switches a user skill and announces it to every project; refuses the rest', async () => {
        const transport = new FixtureTransport();
        const events: ClowdyEvent[] = [];
        const { cursor } = await transport.getRootSnapshot();

        transport.subscribe(
            cursor,
            event => events.push(event),
            () => undefined
        );

        expect(
            await transport.command({ type: 'skills.setEnabled', name: 'user:sql-review', enabled: true })
        ).toMatchObject({ ok: true, data: { name: 'user:sql-review', enabled: true } });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(events.map(event => event.data.type)).toEqual(['skills.changed', 'skills.changed', 'skills.changed']);
        expect(events.map(event => event.projectId).sort()).toEqual(
            [FIXTURE_PROJECT_ID, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID].sort()
        );
        expect((await transport.getSkills()).entries.find(entry => entry.name === 'user:sql-review')?.enabled).toBe(
            true
        );

        expect(
            await transport.command({ type: 'skills.setEnabled', name: 'clowdy:docs', enabled: false })
        ).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(
            await transport.command({ type: 'skills.setEnabled', name: 'booking-rules', enabled: false })
        ).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(await transport.command({ type: 'skills.setEnabled', name: 'user:nope', enabled: false })).toMatchObject(
            { ok: false, error: { code: 'not_found' } }
        );
    });
});
