import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureHashDir, pruneHashDirs } from './hashDirs';

/** The plugin name; skills appear to the engines as `clowdy:<skill>`. */
export const SYSTEM_PLUGIN_NAME = 'clowdy';

const MANIFEST = '.claude-plugin/plugin.json';
const SKILLS = 'skills';
/** How many materialized copies stay: the one in use and the one before it (a run that started on it may still read it). */
const KEEP_COPIES = 2;

/**
 * Where the system skills are in a repository checkout. A build without the checkout ships the plugin folder
 * (manifest and `skills/`) next to the daemon and names it in `CLOWDY_SYSTEM_SKILLS_DIR`; embedding it into a
 * compiled daemon is not built yet.
 */
export function defaultSystemSkillsSource(): string {
    return fileURLToPath(new URL('../../../../packages/system-skills', import.meta.url));
}

export interface MaterializedSkills {
    /** The plugin folder the engines load: `<dataDir>/system-skills/<hash>`. */
    dir: string;
    hash: string;
}

/**
 * Copies the system skills plugin (the manifest and `skills/`, nothing else) to `<dataDir>/system-skills/<hash>`,
 * where `hash` covers the copied content. Engines load this copy, never the app's own folder, whose path and
 * permissions depend on how the app is installed. A copy that exists is reused when its content still hashes to its
 * name and is rebuilt when someone changed it; copies beyond the newest two are removed. The files are read-only.
 */
export function materializeSystemSkills(source: string, dataDir: string): MaterializedSkills {
    checkManifest(source);

    const hash = hashPlugin(source);
    const parent = join(dataDir, 'system-skills');
    const existing = join(parent, hash);

    if (existsSync(existing) && hashPlugin(existing) !== hash) {
        rmSync(existing, { recursive: true, force: true });
    }

    const dir = ensureHashDir(parent, hash, temp => copyPlugin(source, temp));

    pruneHashDirs(parent, KEEP_COPIES, hash);

    return { dir, hash };
}

function checkManifest(source: string): void {
    let name: unknown;

    try {
        name = (JSON.parse(readFileSync(join(source, MANIFEST), 'utf8')) as { name?: unknown }).name;
    } catch {
        throw new Error(
            `The system skills are missing: ${join(source, MANIFEST)} cannot be read. Set CLOWDY_SYSTEM_SKILLS_DIR to the plugin folder.`
        );
    }

    if (name !== SYSTEM_PLUGIN_NAME) {
        throw new Error(
            `The system skills manifest must be named "${SYSTEM_PLUGIN_NAME}" so skills read ${SYSTEM_PLUGIN_NAME}:<skill>, got ${JSON.stringify(name)}`
        );
    }
}

/** The files that make the plugin, as paths relative to its folder, in a fixed order. */
function pluginFiles(root: string): string[] {
    const files = existsSync(join(root, MANIFEST)) ? [MANIFEST] : [];

    function walk(relative: string): void {
        const entries = readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
        );

        for (const entry of entries) {
            const path = `${relative}/${entry.name}`;

            if (entry.isDirectory()) {
                walk(path);
            } else if (entry.isFile() && entry.name !== '.DS_Store') {
                files.push(path);
            }
        }
    }

    if (existsSync(join(root, SKILLS))) {
        walk(SKILLS);
    }

    return files;
}

/** A short hash of the plugin's file names and contents. */
function hashPlugin(root: string): string {
    const hash = createHash('sha256');

    for (const file of pluginFiles(root)) {
        hash.update(file)
            .update('\0')
            .update(readFileSync(join(root, file)))
            .update('\0');
    }

    return hash.digest('hex').slice(0, 16);
}

function copyPlugin(source: string, target: string): void {
    for (const file of pluginFiles(source)) {
        const to = join(target, file);

        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(source, file), to);
        chmodSync(to, 0o444);
    }
}
