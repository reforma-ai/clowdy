import type { ComposerMentionAttrs } from '@clowdy/components/RichInput';

/** Where a mention is typed: `@` for tasks, chats, documents and files, `/` for skills. */
export const MENTION_TRIGGER = '@';
export const SKILL_TRIGGER = '/';

function field(data: unknown, name: string): string {
    const value = (data as Record<string, unknown> | null | undefined)?.[name];

    return typeof value === 'string' ? value : '';
}

/** A path as a message writes it: `@src/a.ts`, and `@"my notes.md"` when it holds a space. */
function pathMention(path: string): string {
    return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** The agent that reads `$name` for a skill; every other agent takes the command as it is typed, `/name`. */
const DOLLAR_SKILL_ENGINE = 'codex';

/** A skill as the agent that will read the message calls it. */
export function skillCall(name: string, engine?: string): string {
    return engine === DOLLAR_SKILL_ENGINE ? `$${name}` : `/${name}`;
}

/**
 * What a mention says to the agent, over ACP, where a message is plain text. A skill is called the way the `engine` that reads it
 * calls its skills (`skillCall`). A task goes by its key, which the orchestrator resolves with `clowdy task get`; documents and
 * files by their path, and a chat by its stable ID.
 */
export function serializeMention({ kind, data }: ComposerMentionAttrs, engine?: string): string {
    switch (kind) {
        case 'task':
            return field(data, 'key');
        case 'chat':
            return `\`chat:${field(data, 'chatId')}\``;
        case 'doc':
        case 'file':
            return pathMention(field(data, 'path'));
        case 'command':
            return skillCall(field(data, 'name'), engine);
        default:
            return '';
    }
}
