import type { ComposerMentionAttrs } from '@clowdy/components/RichInput';

/** Where a mention is typed: `@` for tasks, documents and files, `/` for skills. */
export const MENTION_TRIGGER = '@';
export const SKILL_TRIGGER = '/';

function field(data: unknown, name: string): string {
    const value = (data as Record<string, unknown> | null | undefined)?.[name];

    return typeof value === 'string' ? value : '';
}

/** A path as a message writes it: `@src/a.ts`, and `@"my notes.md"` when it holds a space. */
function pathMention(path: string): string {
    return /\s/.test(path) ? `@"${ path }"` : `@${ path }`;
}

/**
 * What a mention says to the agent. Over ACP a message is plain text and only an agent knows how to call its own skills
 * (`/name` for one, `$name` for another, none for a third), so a skill is asked for in words every agent follows.
 * A task goes by its key, which the orchestrator resolves with `clowdy task get`; documents and files by their path.
 */
export function serializeMention({ kind, data }: ComposerMentionAttrs): string {
    switch (kind) {
        case 'task':
            return field(data, 'key');
        case 'doc':
        case 'file':
            return pathMention(field(data, 'path'));
        case 'command':
            return `Use the skill "${ field(data, 'name') }"`;
        default:
            return '';
    }
}
