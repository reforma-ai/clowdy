import { lstat, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

const KEEP_COPIES_MS = 7 * 24 * 60 * 60 * 1000;
const COPY_FOLDER = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/;

/** Only legacy copies expire; new discards make none. A legacy copy with no manifest is judged by its folder's time. */
export async function pruneDiscardCopies(dataDir: string): Promise<void> {
    const root = join(dataDir, 'discarded');
    const now = Date.now();

    if (!(await lstat(root).catch(() => undefined))?.isDirectory()) return;

    for (const project of await readdir(root).catch(() => [] as string[])) {
        const directory = join(root, project);

        if (!(await lstat(directory).catch(() => undefined))?.isDirectory()) continue;

        for (const name of await readdir(directory).catch(() => [] as string[])) {
            if (!COPY_FOLDER.test(name)) continue;

            const folder = join(directory, name);
            const info = await lstat(folder).catch(() => undefined);

            if (!info?.isDirectory()) continue;

            let at = info.mtimeMs;
            try {
                const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')) as { at?: number };
                if (typeof manifest.at === 'number' && Number.isFinite(manifest.at)) at = manifest.at;
            } catch {
                // An incomplete legacy copy expires according to the folder's own time.
            }

            if (now - at > KEEP_COPIES_MS) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
        }

        // Only empty project folders are removed. Unexpired copies and unrelated entries stay.
        await rmdir(directory).catch(() => undefined);
    }
}
