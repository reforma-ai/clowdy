import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { findProjectIcon, MAX_ICON_FILE_BYTES } from '../src/domain/projectIcon';
import { cleanTempDirs, startHarness, tempDir } from './helpers';

import type { Project } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** Writes files below `root`, making their folders. */
function files(root: string, entries: Record<string, string | Uint8Array>): void {
    for (const [path, content] of Object.entries(entries)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

/** A folder with these files, and the path below it (real, as the daemon reports it) of the icon it finds. */
function found(entries: Record<string, string | Uint8Array>): string | undefined {
    const root = realpathSync.native(tempDir('icon'));

    files(root, entries);

    const icon = findProjectIcon(root);

    return icon && icon.path.slice(root.length + 1);
}

describe('findProjectIcon', () => {
    test('finds nothing in a folder without an icon', () => {
        expect(found({ 'README.md': '# app', 'src/index.ts': '' })).toBeUndefined();
    });

    test('takes a drawing over an app icon over a .ico, and the root over a static folder', () => {
        expect(found({ 'favicon.ico': 'ico', 'favicon.svg': '<svg/>' })).toBe('favicon.svg');
        expect(found({ 'public/favicon.ico': 'ico', 'public/apple-touch-icon.png': 'png' })).toBe('public/apple-touch-icon.png');
        expect(found({ 'public/favicon.svg': '<svg/>', 'favicon.ico': 'ico' })).toBe('favicon.ico');
    });

    test('knows the places of the common tools', () => {
        expect(found({ 'app/icon.png': 'png' })).toBe('app/icon.png');
        expect(found({ 'src/app/favicon.ico': 'ico' })).toBe('src/app/favicon.ico');
        expect(found({ 'static/favicon.png': 'png' })).toBe('static/favicon.png');
        expect(found({ 'assets/icon.png': 'png' })).toBe('assets/icon.png');
        expect(found({ 'build/icon.png': 'png' })).toBe('build/icon.png');
    });

    test('looks in the packages of a monorepo, in name order, when the root has none', () => {
        expect(found({ 'apps/web/public/favicon.ico': 'ico', 'apps/admin/public/favicon.svg': '<svg/>' })).toBe('apps/admin/public/favicon.svg');
        expect(found({ 'packages/ui/public/favicon.ico': 'ico' })).toBe('packages/ui/public/favicon.ico');
        expect(found({ 'apps/web/public/favicon.svg': '<svg/>', 'public/favicon.ico': 'ico' })).toBe('public/favicon.ico');
    });

    test('passes over an empty file, one that is too large, and a folder by an icon\'s name', () => {
        expect(found({ 'favicon.svg': '', 'favicon.ico': 'ico' })).toBe('favicon.ico');
        expect(found({ 'favicon.svg': new Uint8Array(MAX_ICON_FILE_BYTES + 1), 'favicon.ico': 'ico' })).toBe('favicon.ico');
        expect(found({ 'favicon.svg/inside': 'x', 'favicon.ico': 'ico' })).toBe('favicon.ico');
    });

    test('never follows a link out of the folder', () => {
        const outside = tempDir('outside');
        const root = realpathSync.native(tempDir('icon'));

        files(outside, { 'secret.png': 'not yours' });
        symlinkSync(join(outside, 'secret.png'), join(root, 'favicon.png'));

        expect(findProjectIcon(root)).toBeUndefined();
    });

    test('says what kind of picture it is', () => {
        const root = realpathSync.native(tempDir('icon'));

        files(root, { 'favicon.ico': 'ico' });
        expect(findProjectIcon(root)?.mediaType).toBe('image/x-icon');
    });
});

describe('the project icon', () => {
    let h: Harness;

    afterEach(() => h.stop());

    test('GET /icon serves the icon of the main folder, and is not found without one or for the personal space', async () => {
        h = await startHarness();

        const { id, path } = h.openRepo('web');
        const none = await h.fetch(`/v1/projects/${ id }/icon`);

        expect(none.status).toBe(404);
        expect(await none.json()).toMatchObject({ ok: false, error: { code: 'not_found' } });

        files(path, { 'public/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' });

        const icon = await h.fetch(`/v1/projects/${ id }/icon`);

        expect(icon.status).toBe(200);
        expect(icon.headers.get('content-type')).toBe('image/svg+xml');
        expect(icon.headers.get('content-security-policy')).toBe('sandbox');
        expect(icon.headers.get('x-content-type-options')).toBe('nosniff');
        expect(icon.headers.get('cache-control')).toBe('no-store');
        expect(await icon.text()).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');

        files(h.config.personalDir, { 'favicon.ico': 'ico' });
        expect((await h.fetch(`/v1/projects/${ h.personal.id }/icon`)).status).toBe(404);
    });

    test('an uploaded icon is a PNG data URL in the settings, cleared with null, and refused for the personal space', async () => {
        h = await startHarness();

        const { id } = h.openRepo('web');
        const set = h.ok('project.update', { projectId: id, settings: { icon: PNG } }).project as Project;

        expect(set.settings.icon).toBe(PNG);
        expect((h.ok('project.update', { projectId: id, settings: { icon: null } }).project as Project).settings.icon).toBeUndefined();

        const refused = h.send('project.update', { projectId: h.personal.id, settings: { icon: PNG } });

        expect(refused.ok ? undefined : refused.error).toMatchObject({ code: 'conflict', message: 'The personal space has no icon of its own' });
    });

    test('over HTTP an icon that is not a small PNG data URL is refused', async () => {
        h = await startHarness();

        const { id } = h.openRepo('web');
        const send = async (icon: string) => (await h.fetch('/v1/commands', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: crypto.randomUUID(), type: 'project.update', projectId: id, settings: { icon } }),
        })).status;

        expect(await send(PNG)).toBe(200);
        expect(await send('data:image/svg+xml;base64,PHN2Zy8+')).toBe(400);
        expect(await send('https://example.com/icon.png')).toBe(400);
        expect(await send(`data:image/png;base64,${ 'A'.repeat(64 * 1024) }`)).toBe(400);
    });
});
