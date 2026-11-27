import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'bun';

import type { RuntimeTarget } from './bun-runtime';

const root = path.resolve(import.meta.dir, '..');

/** Builds only requested Mac targets; Windows builds need neither Xcode nor the addon. */
export async function buildNativeScroll(targets: readonly RuntimeTarget[]): Promise<void> {
    const macTargets = targets.filter(target => target.startsWith('darwin-'));

    if (!macTargets.length) return;
    if (process.platform !== 'darwin') throw new Error('Building the macOS scroll addon requires macOS and Xcode');

    const headers = path.dirname(Bun.resolveSync('node-api-headers/package.json', root));

    for (const target of macTargets) {
        const output = path.join(root, 'runtime', target, 'scroll.node');
        const arch = target === 'darwin-arm64' ? 'arm64' : 'x86_64';

        await mkdir(path.dirname(output), { recursive: true });
        await $`xcrun clang++ -std=c++17 -fobjc-arc -bundle -undefined dynamic_lookup -arch ${arch} -mmacosx-version-min=11.0 -I${path.join(headers, 'include')} -framework AppKit ${path.join(root, 'native/scroll.mm')} -o ${output}`;
    }
}
