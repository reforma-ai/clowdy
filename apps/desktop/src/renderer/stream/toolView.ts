export type ToolIcon = 'file' | 'search' | 'code' | 'terminal' | 'tool';

export interface ToolView {
    icon: ToolIcon;
    /** What the tool is doing, in the present tense: `Reading file`. For a command, what the agent says it does, and empty when it said nothing: the command speaks for itself. */
    verb: string;
    /** The path, pattern or command it works on, shown as a code chip. */
    target?: string;
    diff?: { added: number; removed: number };
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length);

/** The first of `keys` that holds a non-empty string. */
export function firstString(value: unknown, keys: string[]): string | undefined {
    if (!isRecord(value)) return undefined;

    for (const key of keys) {
        const found = value[key];

        if (typeof found === 'string' && found !== '') return found;
    }

    return undefined;
}

/** `create_task` becomes `Create task`. */
function humanize(name: string): string {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();

    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Lines added and removed: reported by the tool in its output, or counted from the edit it was asked to make. */
function diffStat(input: unknown, output: unknown): ToolView['diff'] {
    if (isRecord(output) && typeof output.added === 'number' && typeof output.removed === 'number') {
        return { added: output.added, removed: output.removed };
    }

    if (!isRecord(input)) return undefined;

    if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
        return { added: lineCount(String(input.new_string ?? '')), removed: lineCount(String(input.old_string ?? '')) };
    }

    return typeof input.content === 'string' ? { added: lineCount(input.content), removed: 0 } : undefined;
}

const PATH_KEYS = ['file_path', 'path', 'file', 'filePath'];

// The names agents give their tools, as `toolKey` writes them: lower case, letters and digits only.
const READ_TOOLS = ['read', 'readfile', 'view', 'cat'];
const EDIT_TOOLS = ['edit', 'multiedit', 'editfile', 'strreplace', 'strreplaceeditor', 'applypatch'];
const WRITE_TOOLS = ['write', 'writefile', 'createfile'];
const SEARCH_TOOLS = ['grep', 'search', 'ripgrep', 'websearch'];
const GLOB_TOOLS = ['glob'];
const LIST_TOOLS = ['ls', 'list', 'listdir', 'listdirectory'];
const COMMAND_TOOLS = ['bash', 'shell', 'run', 'runcommand', 'exec', 'terminal', 'command'];

const toolKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** What the agent says a command does, for any tool that takes such a field (Claude Code's `Bash` has `description`): one line, and not the command again. */
function commandTitle(input: unknown, command?: string): string {
    const description = firstString(input, ['description'])?.split('\n')[0]?.trim();

    return description && description !== command?.trim() ? description : '';
}

/**
 * How a tool call reads in the stream. The daemon passes the engine's tool names and inputs through, so this
 * recognises the common shapes (Claude Code's `Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`, and close
 * relatives) and falls back to the humanized tool name and its first short text argument.
 */
export function describeTool(name: string, input: unknown, output?: unknown): ToolView {
    const key = toolKey(name);

    if (READ_TOOLS.includes(key)) return { icon: 'file', verb: 'Reading file', target: firstString(input, PATH_KEYS) };

    if (EDIT_TOOLS.includes(key)) {
        return { icon: 'code', verb: 'Editing file', target: firstString(input, PATH_KEYS), diff: diffStat(input, output) };
    }

    if (WRITE_TOOLS.includes(key)) {
        return { icon: 'code', verb: 'Writing file', target: firstString(input, PATH_KEYS), diff: diffStat(input, output) };
    }

    if (SEARCH_TOOLS.includes(key)) return { icon: 'search', verb: 'Searching', target: firstString(input, ['pattern', 'query', 'q']) };

    if ([...GLOB_TOOLS, ...LIST_TOOLS].includes(key)) return { icon: 'search', verb: 'Finding files', target: firstString(input, ['pattern', 'path']) };

    if (COMMAND_TOOLS.includes(key)) {
        const command = firstString(input, ['command', 'cmd']);

        return { icon: 'terminal', verb: commandTitle(input, command), target: command };
    }

    const target = isRecord(input) ? Object.values(input).find((value): value is string => typeof value === 'string' && value !== '' && value.length <= 80) : undefined;

    return { icon: 'tool', verb: humanize(name), target };
}

/** What a tool call does, in the terms a summary of many calls needs (`summarizeTools`). */
export type ToolActivity = 'read' | 'list' | 'search' | 'edit' | 'command' | 'other';

/**
 * What a call does and, for those that work on a file or a folder, which one, so that reading the same file twice is one file. A search covers the web
 * (`WebSearch`, `WebFetch`); an edit covers writing, deleting and moving a file. Anything else is `other`.
 */
export function classifyTool(name: string, input: unknown): { activity: ToolActivity; target?: string } {
    const key = toolKey(name);

    if (READ_TOOLS.includes(key)) return { activity: 'read', target: firstString(input, PATH_KEYS) };

    if ([...EDIT_TOOLS, ...WRITE_TOOLS, 'delete', 'remove', 'move'].includes(key)) return { activity: 'edit', target: firstString(input, PATH_KEYS) };

    if ([...SEARCH_TOOLS, ...GLOB_TOOLS, 'webfetch', 'fetch'].includes(key)) return { activity: 'search' };

    // A listing with no folder named is the working folder.
    if (LIST_TOOLS.includes(key)) return { activity: 'list', target: firstString(input, ['path', 'dir', 'directory']) ?? '.' };

    if (COMMAND_TOOLS.includes(key)) return { activity: 'command' };

    return { activity: 'other' };
}
