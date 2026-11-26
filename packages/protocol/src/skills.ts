/**
 * Where a skill comes from. System skills ship with Clowdy, user skills live in the
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
    /** Individual selection; system entries are also subject to the catalog-wide systemEnabled switch. */
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
    /** Whether selected system skills are delivered to new agent sessions. */
    systemEnabled: boolean;
    /** Estimated tokens the enabled skills cost in every run, for the engine that sees the most. */
    tokens: number;
    /** Problems found while reading the skill folders (a skipped skill, a cap hit, a large catalog), in plain words. */
    warnings: string[];
}
