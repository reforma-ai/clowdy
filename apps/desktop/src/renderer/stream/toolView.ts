export type ToolIcon = 'file' | 'search' | 'code' | 'terminal' | 'tool';

export interface ToolView {
    icon: ToolIcon;
    /** What the tool is doing, in the present tense: `Reading file`. Empty for a command, which speaks for itself. */
    verb: string;
    /** The path, pattern or command it works on, shown as a code chip. */
    target?: string;
    diff?: { added: number; removed: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length);

/** The first of `keys` that holds a non-empty string. */
function firstString(value: unknown, keys: string[]): string | undefined {
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

/**
 * How a tool call reads in the stream. The daemon passes the engine's tool names and inputs through, so this
 * recognises the common shapes (Claude Code's `Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`, and close
 * relatives) and falls back to the humanized tool name and its first short text argument.
 */
export function describeTool(name: string, input: unknown, output?: unknown): ToolView {
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (['read', 'readfile', 'view', 'cat'].includes(key)) return { icon: 'file', verb: 'Reading file', target: firstString(input, PATH_KEYS) };

    if (['edit', 'multiedit', 'editfile', 'strreplace', 'strreplaceeditor', 'applypatch'].includes(key)) {
        return { icon: 'code', verb: 'Editing file', target: firstString(input, PATH_KEYS), diff: diffStat(input, output) };
    }

    if (['write', 'writefile', 'createfile'].includes(key)) {
        return { icon: 'code', verb: 'Writing file', target: firstString(input, PATH_KEYS), diff: diffStat(input, output) };
    }

    if (['grep', 'search', 'ripgrep', 'websearch'].includes(key)) return { icon: 'search', verb: 'Searching', target: firstString(input, ['pattern', 'query', 'q']) };

    if (['glob', 'ls', 'list', 'listdir', 'listdirectory'].includes(key)) return { icon: 'search', verb: 'Finding files', target: firstString(input, ['pattern', 'path']) };

    if (['bash', 'shell', 'run', 'runcommand', 'exec', 'terminal', 'command'].includes(key)) return { icon: 'terminal', verb: '', target: firstString(input, ['command', 'cmd']) };

    const target = isRecord(input) ? Object.values(input).find((value): value is string => typeof value === 'string' && value !== '' && value.length <= 80) : undefined;

    return { icon: 'tool', verb: humanize(name), target };
}
