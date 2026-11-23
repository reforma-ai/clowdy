/** The file every skill folder holds. */
export const SKILL_FILE = 'SKILL.md';

/** Claude Code cuts a skill's description in its listing at this many characters; so do we. */
export const MAX_DESCRIPTION_CHARS = 1536;

const MAX_NAME_CHARS = 64;
// Ported from Reforma's `packages/lib/src/skills.ts` (`isValidSkillName`, `splitSkillMarkdown`), with a real YAML parser instead of its field matcher.
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
// `---`, the YAML block (possibly empty), `---`. A byte order mark and CRLF line ends are fine.
const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** A skill's folder name is its name, and the name becomes a symlink name, so it must be a plain word. */
export function isValidSkillName(name: string): boolean {
    return name.length <= MAX_NAME_CHARS && NAME_PATTERN.test(name) && !name.includes('..');
}

export type ParsedSkill = { ok: true; description: string; truncated: boolean } | { ok: false; reason: string };

/**
 * Reads what a catalog needs from a SKILL.md: a description (required) and, when `name` is given, a name that
 * matches the folder. Other keys are the engines' business and ignored. Values may be quoted or block scalars.
 */
export function parseSkillFile(raw: string, folder: string): ParsedSkill {
    const block = FRONT_MATTER.exec(raw.startsWith('\uFEFF') ? raw.slice(1) : raw);

    if (!block) {
        return { ok: false, reason: 'it has no front matter (the --- block at the top)' };
    }

    let data: unknown;

    try {
        data = Bun.YAML.parse(block[1] ?? '') ?? {};
    } catch {
        return { ok: false, reason: 'its front matter is not valid YAML (quote values that contain a colon)' };
    }

    if (typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, reason: 'its front matter is not a list of key: value lines' };
    }

    const { name, description } = data as Record<string, unknown>;

    if (name !== undefined && String(name) !== folder) {
        return { ok: false, reason: `its name "${String(name)}" differs from the folder name` };
    }

    const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';

    if (!text) {
        return { ok: false, reason: 'it has no description' };
    }

    return {
        ok: true,
        description: text.slice(0, MAX_DESCRIPTION_CHARS),
        truncated: text.length > MAX_DESCRIPTION_CHARS,
    };
}
