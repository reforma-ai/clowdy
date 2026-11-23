import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Folders named by the hash of their content: `<parent>/<hash>`. Content never changes under a name, so a path
 * an engine was given stays valid and a folder that exists is the right one.
 *
 * Builds `<parent>/<hash>` with `build` in a temporary folder and renames it into place, so nobody sees it half
 * made. A folder that already exists is kept and marked as used now. Returns its path.
 */
export function ensureHashDir(parent: string, hash: string, build: (dir: string) => void): string {
    const target = join(parent, hash);

    if (existsSync(target)) {
        const now = new Date();

        utimesSync(target, now, now);

        return target;
    }

    mkdirSync(parent, { recursive: true });

    const temp = mkdtempSync(join(parent, '.tmp-'));

    try {
        build(temp);
        renameSync(temp, target);
    } catch (error) {
        rmSync(temp, { recursive: true, force: true });

        if (!existsSync(target)) {
            throw error;
        }
    }

    return target;
}

/**
 * Removes the hash folders of `parent` beyond the `keep` most recently made or used; `current` always stays and
 * counts as one. Also removes temporary folders a crash left behind (one daemon owns the data folder, so none is live).
 */
export function pruneHashDirs(parent: string, keep: number, current: string): void {
    const folders = readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory());

    for (const { name } of folders.filter(entry => entry.name.startsWith('.tmp-'))) {
        rmSync(join(parent, name), { recursive: true, force: true });
    }

    const others = folders
        .filter(entry => !entry.name.startsWith('.') && entry.name !== current)
        .map(entry => ({ name: entry.name, usedAt: statSync(join(parent, entry.name)).mtimeMs }))
        .sort((a, b) => b.usedAt - a.usedAt);

    for (const { name } of others.slice(Math.max(0, keep - 1))) {
        rmSync(join(parent, name), { recursive: true, force: true });
    }
}
