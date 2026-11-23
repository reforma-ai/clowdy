import type { SkillEngine, SkillEntry, SkillSource } from '@clowdy/protocol';

export interface SkillGroup {
    source: SkillSource;
    title: string;
    /** Where the skills come from and what the person can do with them. */
    hint: string;
    /** What to say when the group has no skill. */
    empty: string;
    skills: SkillEntry[];
}

/**
 * The catalog as the page shows it: System, User, then the project's skills when a project is open. The daemon
 * already sorts the entries; this keeps their order inside each group.
 */
export function groupSkills(entries: readonly SkillEntry[], projectName?: string): SkillGroup[] {
    const groups: SkillGroup[] = [
        {
            source: 'system',
            title: 'System',
            hint: 'Come with Clowdy and teach agents how to work here. Always on.',
            empty: 'No system skills are installed.',
            skills: [],
        },
        {
            source: 'user',
            title: 'User',
            hint: 'From ~/.claude/skills and ~/.agents/skills on this computer. Switch off the ones agents should not use.',
            empty: 'You have no skills of your own yet. A skill is a folder with a SKILL.md file; put it in ~/.claude/skills or ~/.agents/skills and it shows up here.',
            skills: [],
        },
    ];

    if (projectName !== undefined) {
        groups.push({
            source: 'project',
            title: 'Project',
            hint: `From the .claude/skills and .agents/skills folders of ${projectName}. Always on for this project.`,
            empty: `${projectName} has no skills of its own. Add a folder with a SKILL.md file to .claude/skills (for Claude) or .agents/skills (for Codex) in the project.`,
            skills: [],
        });
    }

    for (const entry of entries) {
        groups.find(group => group.source === entry.source)?.skills.push(entry);
    }

    return groups;
}

export function engineLabel(engines: readonly SkillEngine[]): string {
    const names = engines.map(engine => (engine === 'claude' ? 'Claude' : 'Codex'));

    return names.length > 1 ? names.join(' and ') : `${names[0] ?? 'No engine'} only`;
}

export function tokenLabel(tokens: number): string {
    return `${tokens.toLocaleString('en-US')} tokens`;
}
