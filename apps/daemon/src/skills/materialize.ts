import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * name and is rebuilt when someone changed it. Filtered copies omit disabled skills and references to them,
 * and remain available to running sessions. The files are read-only.
 */
export function materializeSystemSkills(
    source: string,
    dataDir: string,
    disabled?: ReadonlySet<string>
): MaterializedSkills {
    checkManifest(source);

    const files = pluginFiles(source).filter(file => !disabled?.has(file.split('/')[1]) || !file.startsWith('skills/'));
    const content = (file: string) => {
        const bytes = readFileSync(join(source, file));

        if (!disabled?.size || !file.endsWith('.md')) return bytes;

        const references = [...disabled].map(name => `clowdy:${name}`);
        return Buffer.from(
            bytes
                .toString('utf8')
                .split('\n')
                .map(line => filterReferences(line, references))
                .filter(line => line !== undefined)
                .join('\n')
        );
    };
    const hash = hashFiles(files, content);
    const parent = join(dataDir, disabled ? 'system-skills-active' : 'system-skills');
    const existing = join(parent, hash);

    if (existsSync(existing) && hashPlugin(existing) !== hash) {
        rmSync(existing, { recursive: true, force: true });
    }

    const dir = ensureHashDir(parent, hash, temp => {
        mkdirSync(join(temp, SKILLS), { recursive: true });
        for (const file of files) {
            const to = join(temp, file);
            mkdirSync(dirname(to), { recursive: true });
            writeFileSync(to, content(file));
            chmodSync(to, 0o444);
        }
    });

    if (!disabled) pruneHashDirs(parent, KEEP_COPIES, hash);

    return { dir, hash };
}

/** Remove sentences that name unavailable skills while retaining independent sentences on the same line. */
function filterReferences(line: string, references: readonly string[]): string | undefined {
    if (!references.some(ref => line.includes(ref))) return line;
    if (line.startsWith('description:')) return 'description: Clowdy system skill';

    // The mode instruction names both alternatives in one sentence; keep the available one.
    const modeInstruction =
        'As soon as the message turns out to be a change and not a pure question, load clowdy:autopilot or clowdy:semi-manual and follow it.';
    if (line.includes(modeInstruction)) {
        const choices = [
            !references.includes('clowdy:autopilot') && 'clowdy:autopilot for autopilot mode',
            !references.includes('clowdy:semi-manual') && 'clowdy:semi-manual for semi-manual mode',
        ].filter(Boolean);
        line = line.replace(modeInstruction, choices.length ? `For a change, load ${choices.join(' or ')}.` : '');
    }

    const prefix = /^(\s*(?:- |\d+\. )?(?:\*\*[^*]+\*\*\s*)?)/.exec(line)?.[0] ?? '';
    const body = line.slice(prefix.length);
    const kept = body
        .split(/(?<=[.!?]) +(?=[A-Z])/)
        .filter(sentence => !references.some(ref => sentence.includes(ref)));
    return kept.length && kept.join(' ').trim() ? `${prefix}${kept.join(' ')}` : undefined;
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
function hashFiles(files: string[], content: (file: string) => Buffer): string {
    const hash = createHash('sha256');

    for (const file of files) {
        hash.update(file).update('\0').update(content(file)).update('\0');
    }

    return hash.digest('hex').slice(0, 16);
}

function hashPlugin(root: string): string {
    return hashFiles(pluginFiles(root), file => readFileSync(join(root, file)));
}
