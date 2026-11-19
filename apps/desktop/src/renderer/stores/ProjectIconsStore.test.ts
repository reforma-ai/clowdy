import { NO_PROJECT_ICON } from '@clowdy/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectIconsStore } from './ProjectIconsStore';

import type { Project } from '@clowdy/protocol';
import type { Transport } from '../daemon/transport';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

let made = 0;
const revoked: string[] = [];

beforeEach(() => {
    made = 0;
    revoked.length = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:icon-${ ++made }`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => void revoked.push(url));
});

afterEach(() => vi.restoreAllMocks());

function project(rest: Partial<Project> = {}): Project {
    return { id: 'p1', name: 'Web', folders: [{ id: 'f1', path: '/code/web' }], taskPrefix: 'WEB', settings: {}, createdAt: 0, position: 1, ...rest };
}

function icons(getProjectIcon: Transport['getProjectIcon']): ProjectIconsStore {
    return new ProjectIconsStore({ getProjectIcon } as unknown as Transport);
}

describe('ProjectIconsStore', () => {
    it('shows the icon found in the main folder, asked once for that folder', async () => {
        const read = vi.fn(async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }));
        const store = icons(read);
        const web = project();

        expect(store.src(web)).toBeUndefined();

        await Promise.all([store.load(web.id, '/code/web'), store.load(web.id, '/code/web')]);
        await store.load(web.id, '/code/web');

        expect(read).toHaveBeenCalledTimes(1);
        expect(store.foundIcon(web)).toBe('blob:icon-1');
        expect(store.src(web)).toBe('blob:icon-1');
    });

    it('knows a folder with no icon, and asks again after a read that failed', async () => {
        const read = vi.fn<Transport['getProjectIcon']>().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
        const store = icons(read);
        const web = project();

        await store.load(web.id, '/code/web');
        expect(store.foundIcon(web)).toBeUndefined();

        await store.load(web.id, '/code/web');
        expect(read).toHaveBeenCalledTimes(2);
        expect(store.foundIcon(web)).toBeNull();
        expect(store.src(web)).toBeUndefined();
    });

    it('reads a new main folder again and lets go of the icon of the old one', async () => {
        const store = icons(async () => new Blob(['png']));
        const before = project();
        const after = project({ folders: [{ id: 'f2', path: '/code/api' }, ...before.folders] });

        await store.load(before.id, '/code/web');
        // Until the new folder is read, the old folder's icon is not shown for it.
        expect(store.src(after)).toBeUndefined();

        await store.load(after.id, '/code/api');
        expect(store.src(after)).toBe('blob:icon-2');
        expect(revoked).toEqual(['blob:icon-1']);
    });

    it('keeps only the answer for the newest main folder when two reads cross', async () => {
        let answerFirst: (blob: Blob) => void = () => undefined;
        const read = vi.fn<Transport['getProjectIcon']>()
            .mockImplementationOnce(() => new Promise((resolve) => {
                answerFirst = resolve;
            }))
            .mockResolvedValueOnce(new Blob(['api']));
        const store = icons(read);
        const first = store.load('p1', '/code/web');

        await store.load('p1', '/code/api');
        answerFirst(new Blob(['web']));
        await first;

        expect(store.foundIcon(project({ folders: [{ id: 'f2', path: '/code/api' }] }))).toBe('blob:icon-1');
        expect(revoked).toEqual(['blob:icon-2']);
    });

    it('drops a read for a folder the project left again before it answered', async () => {
        let answerApi: (blob: Blob) => void = () => undefined;
        const read = vi.fn<Transport['getProjectIcon']>()
            .mockResolvedValueOnce(new Blob(['web']))
            .mockImplementationOnce(() => new Promise((resolve) => {
                answerApi = resolve;
            }));
        const store = icons(read);

        await store.load('p1', '/code/web');

        const api = store.load('p1', '/code/api');

        await store.load('p1', '/code/web');
        answerApi(new Blob(['api']));
        await api;

        expect(read).toHaveBeenCalledTimes(2);
        expect(store.foundIcon(project())).toBe('blob:icon-1');
        expect(revoked).toEqual(['blob:icon-2']);
    });

    it('shows an uploaded picture first, and the folder icon once the person removed the icon or for the personal space', async () => {
        const store = icons(async () => new Blob(['png']));

        await store.load('p1', '/code/web');

        expect(store.src(project({ settings: { icon: PNG } }))).toBe(PNG);
        expect(store.src(project({ settings: { icon: NO_PROJECT_ICON } }))).toBeUndefined();
        expect(store.src(project({ personal: true }))).toBeUndefined();
    });

    it('needs the folder\'s icon unless the project has a picture of its own or is the personal space', () => {
        const store = icons(async () => undefined);

        expect(store.wantsFound(project())).toBe(true);
        // After a removal Settings offers the favicon back, so it is still read.
        expect(store.wantsFound(project({ settings: { icon: NO_PROJECT_ICON } }))).toBe(true);
        expect(store.wantsFound(project({ settings: { icon: PNG } }))).toBe(false);
        expect(store.wantsFound(project({ personal: true }))).toBe(false);
    });
});
