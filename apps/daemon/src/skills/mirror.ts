import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureHashDir, pruneHashDirs } from './hashDirs';

import type { ScannedSkill } from './scan';

/** The plugin name; engines show the skills as `user:<skill>`. */
export const USER_PLUGIN_NAME = 'user';

/** Older mirrors stay a while: a run that started on one reads skill files through it until it ends. */
const KEEP_MIRRORS = 5;

/**
 * Builds the folder engines load the person's own skills from: a plugin named `user` whose `skills/` holds one
 * link per enabled skill, pointing at the skill's real folder (a copy on Windows, where links need rights).
 * Engines see these skills without reading `~/.claude` settings, hooks or CLAUDE.md, and `~/.agents/skills` reaches
 * Claude too. The folder is named by a hash of what it holds, so a change makes a new one and old paths stay valid.
 * Returns undefined when there is no skill to load.
 */
export function buildUserMirror(dataDir: string, skills: readonly ScannedSkill[]): string | undefined {
    if (skills.length === 0) {
        return undefined;
    }

    const parent = join(dataDir, 'user-skills-plugin');
    const hash = createHash('sha256')
        .update(JSON.stringify(skills.map(({ folder, real, mtimeMs, size }) => [folder, real, mtimeMs, size])))
        .digest('hex')
        .slice(0, 16);
    const dir = ensureHashDir(parent, hash, (temp) => {
        mkdirSync(join(temp, '.claude-plugin'));
        mkdirSync(join(temp, 'skills'));
        writeFileSync(join(temp, '.claude-plugin', 'plugin.json'), `${ JSON.stringify({ name: USER_PLUGIN_NAME, version: '0.1.0', description: 'Skills from your own skill folders' }, null, 4) }\n`);

        for (const { folder, real } of skills) {
            const link = join(temp, 'skills', folder);

            if (process.platform === 'win32') {
                cpSync(real, link, { recursive: true });
            }
            else {
                symlinkSync(real, link, 'dir');
            }
        }
    });

    pruneHashDirs(parent, KEEP_MIRRORS, hash);

    return dir;
}
