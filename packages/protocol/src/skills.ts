/**
 * Where a skill comes from. System skills ship with Clowdy and cannot be switched off, user skills live in the
 * person's own skill folders (`~/.claude/skills`, `~/.agents/skills`), project skills in the repository.
 */
export type SkillSource = 'system' | 'user' | 'project';

/** The engines that load skills. A skill is listed for every engine that sees it. */
export type SkillEngine = 'claude' | 'codex';

export interface SkillEntry {
    /** Stable key of the entry, unique within one catalog. */
    id: string;
    /** The name an engine shows: `clowdy:orchestrate` for system skills, `user:deploy` for user skills, `deploy` for project skills. */
    name: string;
    source: SkillSource;
    description: string;
    /** Always true for system and project skills; only user skills can be switched off. */
    enabled: boolean;
    /** The skill's folder; absent for system skills. */
    path?: string;
    /** Estimated tokens the skill's line costs in every run while it is enabled. */
    tokens: number;
    engines: SkillEngine[];
}

/** What `GET /v1/skills` returns. */
export interface SkillCatalog {
    entries: SkillEntry[];
    /** Estimated tokens the enabled skills cost in every run, for the engine that sees the most. */
    tokens: number;
    /** Problems found while reading the skill folders (a skipped skill, a cap hit, a large catalog), in plain words. */
    warnings: string[];
}
