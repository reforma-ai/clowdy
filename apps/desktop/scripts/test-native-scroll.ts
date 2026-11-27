/** Isolated synthetic AppKit test; no Clowdy window or daemon is started. macOS only. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'bun';

import { buildNativeScroll } from './native-scroll';

if (process.platform !== 'darwin' || (process.arch !== 'arm64' && process.arch !== 'x64')) {
    throw new Error('The native scroll test requires macOS on arm64 or x64');
}

const root = path.resolve(import.meta.dir, '..');
const target = `darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64';
const headers = path.dirname(Bun.resolveSync('node-api-headers/package.json', root));
await mkdir(path.join(root, 'runtime'), { recursive: true });
const temporary = await mkdtemp(path.join(root, 'runtime/scroll-test-'));

try {
    await buildNativeScroll([target]);
    const emitter = path.join(temporary, 'emit.node');

    await $`xcrun clang++ -std=c++17 -fobjc-arc -bundle -undefined dynamic_lookup -I${path.join(headers, 'include')} -framework AppKit ${path.join(root, 'native/scroll-test.mm')} -o ${emitter}`;
    const electron = (await import('electron')).default as unknown as string;
    const child = Bun.spawn([electron, path.join(root, 'native/scroll-test.cjs')], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
            ...process.env,
            CLOWDY_SCROLL_TEST_PROFILE: path.join(temporary, 'profile'),
            CLOWDY_SCROLL_TEST_ADDON: path.join(root, 'runtime', target, 'scroll.node'),
            CLOWDY_SCROLL_TEST_EMITTER: emitter,
        },
    });
    const code = await child.exited;

    if (code !== 0) throw new Error(`Native scroll test exited with ${code}`);
} finally {
    await rm(temporary, { recursive: true, force: true });
}
