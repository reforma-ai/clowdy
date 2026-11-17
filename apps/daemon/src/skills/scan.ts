import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { isValidSkillName, MAX_DESCRIPTION_CHARS, parseSkillFile, SKILL_FILE } from './frontmatter';

/** More than this many skills in one folder are ignored (and said so): every listing costs context. */
export const MAX_SKILLS_PER_ROOT = 200;
/** A SKILL.md larger than this is not read. */
export const MAX_SKILL_BYTES = 256 * 1024;

export interface ScannedSkill {
    /** The folder's name, which is the skill's name. */
    folder: string;
    /** The folder as found under the root. */
    dir: string;
    /** The folder with every symlink resolved. */
    real: string;
    description: string;
    mtimeMs: number;
    size: number;
}

export interface RootScan {
    skills: ScannedSkill[];
    /** Changes whenever a skill appears, goes, or its SKILL.md is touched. */
    fingerprint: string;
    warnings: string[];
}

interface Candidate {
    folder: string;
    dir: string;
    real: string;
    mtimeMs: number;
    size: number;
}

const EMPTY_SCAN: RootScan = { skills: [], fingerprint: '', warnings: [] };

/**
 * Reads skill folders: every direct child of a root that holds a SKILL.md, which is where Claude Code and Codex look.
 * A root that does not exist has no skills. Symlinked folders are followed, but each real folder counts once and one
 * that leads back to the root or above it is not a skill, so a loop cannot trap the scan.
 * Reading goes through a cache: a root whose folders and SKILL.md files all kept their mtime and size is not parsed again.
 * The design follows Reforma's `apps/sandbox/src/chat/agent/skills/workspace-skills.ts` (fingerprint of the files, parse on change).
 */
export class SkillScanner {
    private cache = new Map<string, RootScan>();

    scan(root: string): RootScan {
        const found = candidates(root);

        if (!found) {
            this.cache.delete(root);

            return EMPTY_SCAN;
        }

        const fingerprint = JSON.stringify(found.map(({ folder, real, mtimeMs, size }) => [folder, real, mtimeMs, size]));
        const cached = this.cache.get(root);

        if (cached?.fingerprint === fingerprint) {
            return cached;
        }

        const scan = read(found, fingerprint);

        this.cache.set(root, scan);

        return scan;
    }
}

/** The folders under `root` with a SKILL.md, by name. Undefined when the root cannot be listed. */
function candidates(root: string): Candidate[] | undefined {
    let names: string[];
    let rootReal: string;

    try {
        names = readdirSync(root).sort();
        rootReal = realpathSync(root);
    }
    catch {
        return undefined;
    }

    const seen = new Set<string>();
    const found: Candidate[] = [];

    for (const folder of names) {
        if (folder.startsWith('.') || folder === 'node_modules') {
            continue;
        }

        const dir = join(root, folder);

        try {
            const real = realpathSync(dir);
            const file = statSync(join(real, SKILL_FILE));

            if (file.isFile() && !seen.has(real) && real !== rootReal && !rootReal.startsWith(real + sep)) {
                seen.add(real);
                found.push({ folder, dir, real, mtimeMs: file.mtimeMs, size: file.size });
            }
        }
        catch {
            // Not a folder, no SKILL.md, or a link that leads nowhere: not a skill.
        }
    }

    return found;
}

function read(found: Candidate[], fingerprint: string): RootScan {
    const skills: ScannedSkill[] = [];
    const warnings: string[] = [];

    if (found.length > MAX_SKILLS_PER_ROOT) {
        warnings.push(`This folder holds ${ found.length } skills; only the first ${ MAX_SKILLS_PER_ROOT } are listed`);
    }

    for (const candidate of found.slice(0, MAX_SKILLS_PER_ROOT)) {
        const result = readSkill(candidate);

        if (typeof result === 'string') {
            warnings.push(result);
            continue;
        }

        if (result.truncated) {
            warnings.push(`"${ candidate.folder }": the description is cut to its first ${ MAX_DESCRIPTION_CHARS } characters, as the engines do`);
        }

        skills.push(result.skill);
    }

    return { skills, fingerprint, warnings };
}

/** The skill, or why it is skipped. */
function readSkill({ folder, dir, real, mtimeMs, size }: Candidate): { skill: ScannedSkill; truncated: boolean } | string {
    if (!isValidSkillName(folder)) {
        return `Skipped "${ folder }": the folder name may only use letters, digits, ".", "_" and "-" (at most 64)`;
    }

    if (size > MAX_SKILL_BYTES) {
        return `Skipped "${ folder }": its ${ SKILL_FILE } is larger than ${ MAX_SKILL_BYTES / 1024 } KB`;
    }

    let raw: string;

    try {
        raw = readFileSync(join(real, SKILL_FILE), 'utf8');
    }
    catch {
        return `Skipped "${ folder }": its ${ SKILL_FILE } cannot be read`;
    }

    const parsed = parseSkillFile(raw, folder);

    return parsed.ok
        ? { skill: { folder, dir, real, description: parsed.description, mtimeMs, size }, truncated: parsed.truncated }
        : `Skipped "${ folder }": ${ parsed.reason }`;
}
