import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { sha256 } from './bundleManifest';
import { CONTENT_SECURITY_POLICY, createProtocolHandler } from './protocol';
import { APP_ORIGIN } from './security';

const encoder = new TextEncoder();

describe('createProtocolHandler', () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'clowdy-renderer-'));
        await mkdir(path.join(root, 'assets'));
        await writeFile(path.join(root, 'index.html'), 'page');
        await writeFile(path.join(root, 'assets/app.js'), 'app');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const get = async (handler: ReturnType<typeof createProtocolHandler>, pathname: string) => {
        const response = await handler(new Request(`${ APP_ORIGIN }${ pathname }`));

        return { status: response.status, body: await response.text() };
    };
    const entry = (text: string) => ({ sha256: sha256(encoder.encode(text)), size: text.length });

    test('serves the app\'s own copy as it is, and an app route its index', async () => {
        const handler = createProtocolHandler(root);

        expect(await get(handler, '/assets/app.js')).toEqual({ status: 200, body: 'app' });
        expect(await get(handler, '/projects/1')).toEqual({ status: 200, body: 'page' });
        expect((await get(handler, '/missing.js')).status).toBe(404);
    });

    test('serves an installed bundle\'s file only while it matches the manifest', async () => {
        const handler = createProtocolHandler(root, { 'index.html': entry('page'), 'assets/app.js': entry('app') });

        expect(await get(handler, '/assets/app.js')).toEqual({ status: 200, body: 'app' });
        expect(await get(handler, '/projects/1')).toEqual({ status: 200, body: 'page' });

        await writeFile(path.join(root, 'assets/app.js'), 'altered');
        await writeFile(path.join(root, 'assets/extra.js'), 'extra');

        expect((await get(handler, '/assets/app.js')).status).toBe(404);
        expect((await get(handler, '/assets/extra.js')).status).toBe(404);
    });
});

describe('CONTENT_SECURITY_POLICY', () => {
    const directive = (name: string) => CONTENT_SECURITY_POLICY.split('; ').find(part => part.startsWith(`${ name } `));

    test('lets the page frame a blob (the file manager\'s PDF preview) and nothing from outside the app', () => {
        expect(directive('frame-src')).toBe('frame-src \'self\' blob:');
        expect(directive('frame-ancestors')).toBe('frame-ancestors \'none\'');
        expect(directive('object-src')).toBe('object-src \'none\'');
        expect(directive('script-src')).toBe('script-src \'self\' \'wasm-unsafe-eval\'');
    });
});
