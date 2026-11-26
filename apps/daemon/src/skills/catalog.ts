import { SYSTEM_PLUGIN_NAME } from './materialize';
import { USER_PLUGIN_NAME } from './mirror';

import type { SkillCatalog, SkillEngine, SkillEntry } from '@clowdy/protocol';
import type { RootScan, ScannedSkill } from './scan';

const ENGINES: SkillEngine[] = ['claude', 'codex'];
/** Both engines start shortening skill descriptions past about this many tokens (1% to 2% of a typical context window). */
const TOKEN_WARNING = 2000;

/** A skill folder that was read, and how to name it in a warning. */
export interface LabeledScan {
    label: string;
    scan: RootScan;
}

/** A project's skill folder and the one engine that reads it: Claude reads `.claude/skills`, Codex `.agents/skills`. */
export interface ProjectScan extends LabeledScan {
    engine: SkillEngine;
}

/** What a skill's line costs in the engine's skill listing: about 16 tokens of markup and name, plus a quarter token per character. Measured at 33 to 48 for one-line skills. */
export function estimateTokens(name: string, description: string): number {
    return 16 + Math.ceil((name.length + description.length) / 4);
}

/** User skills from several folders, `roots` ordered from the weakest to the strongest: a name in a later folder hides the same name in an earlier one. */
export function mergeUserSkills(roots: readonly LabeledScan[]): { skills: ScannedSkill[]; warnings: string[] } {
    const warnings = roots.flatMap(({ label, scan }) => scan.warnings.map(warning => `${label}: ${warning}`));
    const byName = new Map<string, { skill: ScannedSkill; label: string }>();

    for (const { label, scan } of roots) {
        for (const skill of scan.skills) {
            const hidden = byName.get(skill.folder);

            if (hidden && hidden.skill.real !== skill.real) {
                warnings.push(`"${skill.folder}" in ${hidden.label} is hidden by the one in ${label}`);
            }

            byName.set(skill.folder, { skill, label });
        }
    }

    return { skills: [...byName.values()].map(({ skill }) => skill).sort(byFolder), warnings };
}

export interface CatalogInput {
    /** The skills of the materialized plugin. */
    system: RootScan;
    /** The merged user skills (`mergeUserSkills`). */
    user: { skills: ScannedSkill[]; warnings: string[] };
    project: readonly ProjectScan[];
    /** Folder names of the user skills that are switched off. */
    disabled: ReadonlySet<string>;
    systemDisabled?: ReadonlySet<string>;
    /** Problems found before the catalog was built. */
    warnings?: string[];
}

/**
 * The catalog the API serves. Names are the ones the engines use: `clowdy:` for system skills, `user:` for the
 * person's own (both are plugins), plain for project skills. A user skill that is off still shows, with the cost it would have.
 */
export function buildCatalog({
    system,
    user,
    project,
    disabled,
    systemDisabled = new Set(),
    warnings = [],
}: CatalogInput): SkillCatalog {
    const systemEnabled = !systemDisabled.has('*');
    const entries = [
        ...system.skills.map(skill =>
            entryOf(skill, {
                id: `system:${skill.folder}`,
                name: `${SYSTEM_PLUGIN_NAME}:${skill.folder}`,
                source: 'system',
                enabled: !systemDisabled.has(skill.folder),
                engines: ENGINES,
            })
        ),
        ...user.skills.map(skill =>
            entryOf(skill, {
                id: `user:${skill.folder}`,
                name: `${USER_PLUGIN_NAME}:${skill.folder}`,
                source: 'user',
                enabled: !disabled.has(skill.folder),
                engines: ENGINES,
            })
        ),
        ...projectEntries(project),
    ];
    const tokens = Math.max(
        ...ENGINES.map(engine =>
            entries
                .filter(
                    entry =>
                        entry.enabled && (entry.source !== 'system' || systemEnabled) && entry.engines.includes(engine)
                )
                .reduce((sum, entry) => sum + entry.tokens, 0)
        )
    );
    const all = [
        ...warnings,
        ...system.warnings.map(warning => `System skills: ${warning}`),
        ...user.warnings,
        ...project.flatMap(({ label, scan }) => scan.warnings.map(warning => `${label}: ${warning}`)),
    ];

    if (tokens > TOKEN_WARNING) {
        all.push(
            `The enabled skills cost about ${tokens} tokens in every run; engines shorten descriptions past about ${TOKEN_WARNING}. Switch off skills you do not need`
        );
    }

    return { entries, tokens, warnings: all, systemEnabled };
}

/** A folder both engines read (a link, say) is one skill that both see. */
function projectEntries(roots: readonly ProjectScan[]): SkillEntry[] {
    const byReal = new Map<string, SkillEntry>();

    for (const { label, engine, scan } of roots) {
        for (const skill of scan.skills) {
            const known = byReal.get(skill.real);

            if (known) {
                known.engines.push(engine);
            } else {
                byReal.set(
                    skill.real,
                    entryOf(skill, {
                        id: `project:${label}/${skill.folder}`,
                        name: skill.folder,
                        source: 'project',
                        enabled: true,
                        engines: [engine],
                    })
                );
            }
        }
    }

    return [...byReal.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function entryOf(
    skill: ScannedSkill,
    fields: Pick<SkillEntry, 'id' | 'name' | 'source' | 'enabled' | 'engines'>
): SkillEntry {
    return {
        ...fields,
        description: skill.description,
        // The materialized copy of a system skill is the daemon's business, not a place the person should look.
        ...(fields.source !== 'system' && { path: skill.dir }),
        tokens: estimateTokens(fields.name, skill.description),
        engines: [...fields.engines],
    };
}

const byFolder = (a: ScannedSkill, b: ScannedSkill) => a.folder.localeCompare(b.folder);
