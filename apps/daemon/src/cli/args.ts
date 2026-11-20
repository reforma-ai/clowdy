/**
 * The command line of the `clowdy` program an agent runs in its shell, turned into the input of one of the daemon's tools. The daemon lists the tools the
 * session may call with their JSON Schema (`GET /cli/tools`), so the flags, their types and the help text come from the same schema the model's own
 * tools have: a field `timeoutSeconds` is `--timeout-seconds`, a text field also takes `--<name>-file <path>` (`-` reads stdin) for long text, and
 * the fields a tool names as positional are filled by bare words.
 */

interface Property {
    type?: string;
    description?: string;
    enum?: unknown[];
    items?: { type?: string; enum?: unknown[] };
}

/** A tool as the daemon lists it for a command line. */
export interface CliTool {
    name: string;
    description: string;
    inputSchema: { properties?: Record<string, Property>; required?: string[] };
    /** The fields a bare word fills, in order; the last one, when it is text, takes every word that is left. */
    positional?: string[];
}

/** A command line that cannot be understood: the message says what to fix, and the program exits with 2. */
export class UsageError extends Error {}

/** Where a text comes from instead of the command line: stdin. */
export const STDIN = '-';

export interface ParsedCommand {
    /** The input, except the fields in `files`. */
    arguments: Record<string, unknown>;
    /** Text fields to read before the call, by field name: a file's path, or `-` for stdin (`--prompt-file -`, or a bare `-` in a text field's place). */
    files: Record<string, string>;
    json: boolean;
    help: boolean;
}

/** `thread_spawn` is the command `thread spawn`: the part before the first underscore groups, the rest names. */
export function commandOf(tool: Pick<CliTool, 'name'>): { group: string; command: string } {
    const [group, ...rest] = tool.name.split('_');

    return { group, command: rest.join('-') };
}

export const kebab = (name: string) => name.replaceAll(/[A-Z]/g, letter => `-${ letter.toLowerCase() }`);

/** The flags a tool takes besides `--json` and `--help`: each field, `--no-<field>` for a boolean, `--<field>-file` for text. */
export function flagsOf(tool: CliTool): string[] {
    return Object.entries(tool.inputSchema.properties ?? {}).flatMap(([name, property]) => [
        kebab(name),
        ...(property.type === 'boolean' ? [`no-${ kebab(name) }`] : []),
        ...(property.type === 'string' ? [`${ kebab(name) }-file`] : []),
    ]);
}

/** The field a flag names: itself, `--no-<boolean>`, or `--<text>-file`. */
function resolve(properties: Record<string, Property>, names: Map<string, string>, flag: string): { name: string; fromFile: boolean; negated: boolean } | undefined {
    const direct = names.get(flag);

    if (direct !== undefined) {
        return { name: direct, fromFile: false, negated: false };
    }

    const negated = flag.startsWith('no-') ? names.get(flag.slice(3)) : undefined;

    if (negated !== undefined && properties[negated].type === 'boolean') {
        return { name: negated, fromFile: false, negated: true };
    }

    const file = flag.endsWith('-file') ? names.get(flag.slice(0, -5)) : undefined;

    return file !== undefined && properties[file].type === 'string' ? { name: file, fromFile: true, negated: false } : undefined;
}

function coerce(property: Property, flag: string, value: string): unknown {
    switch (property.type) {
        case 'integer':
        case 'number': {
            const number = Number(value);

            if (value.trim() === '' || Number.isNaN(number) || (property.type === 'integer' && !Number.isInteger(number))) {
                throw new UsageError(`--${ flag } takes ${ property.type === 'integer' ? 'a whole number' : 'a number' }, not "${ value }"`);
            }

            return number;
        }
        case 'boolean':
            if (value !== 'true' && value !== 'false') {
                throw new UsageError(`--${ flag } takes true or false, not "${ value }"`);
            }

            return value === 'true';
        default:
            if (property.enum && !property.enum.includes(value)) {
                throw new UsageError(`--${ flag } is one of ${ property.enum.join(', ') }, not "${ value }"`);
            }

            return value;
    }
}

/**
 * The input of `tool` from the words after its name. `--json`, `--help` and `-h` are the program's own and are returned apart. A text that comes from
 * a file or stdin is named in `files`, for the caller to read. A flag the tool does not have, a value of the wrong type, a field given twice, stdin read
 * twice, a missing required field and a surplus word are `UsageError`s that name the way out.
 */
export function parseCommand(tool: CliTool, words: readonly string[]): ParsedCommand {
    const properties = tool.inputSchema.properties ?? {};
    const names = new Map(Object.keys(properties).map(name => [kebab(name), name]));
    const input: Record<string, unknown> = {};
    const files: Record<string, string> = {};
    const bare: string[] = [];
    let json = false;
    let help = false;

    const given = (name: string) => name in input || name in files;
    const fromSource = (name: string, source: string) => {
        if (source === STDIN && Object.values(files).includes(STDIN)) {
            throw new UsageError('Only one text can come from stdin (-); read the others from files');
        }

        files[name] = source;
    };

    for (let index = 0; index < words.length; index++) {
        const word = words[index];

        if (word === '--') {
            bare.push(...words.slice(index + 1));
            break;
        }

        if (word === '-h') {
            help = true;
            continue;
        }

        if (!word.startsWith('--')) {
            bare.push(word);
            continue;
        }

        const equals = word.indexOf('=');
        const flag = equals < 0 ? word.slice(2) : word.slice(2, equals);
        const inline = equals < 0 ? undefined : word.slice(equals + 1);

        if (flag === 'json' || flag === 'help') {
            json ||= flag === 'json';
            help ||= flag === 'help';
            continue;
        }

        const known = resolve(properties, names, flag);

        if (!known) {
            throw new UsageError(`Unknown option --${ flag }. Options: ${ [...names.keys()].map(option => `--${ option }`).join(', ') || 'none' }`);
        }

        const { name, fromFile, negated } = known;
        const property = properties[name];

        if (given(name) && property.type !== 'array') {
            throw new UsageError(`--${ kebab(name) } is given twice`);
        }

        if (negated) {
            input[name] = false;
            continue;
        }

        let value = inline;

        if (value === undefined && property.type === 'boolean' && !fromFile) {
            value = 'true';
        }

        if (value === undefined) {
            value = words[++index];

            if (value === undefined) {
                throw new UsageError(`--${ flag } needs a value`);
            }
        }

        if (fromFile) {
            fromSource(name, value);
        }
        else if (property.type === 'array') {
            const items = value.split(',').map(item => item.trim()).filter(Boolean).map(item => coerce(property.items ?? {}, flag, item));

            input[name] = [...(input[name] as unknown[] | undefined ?? []), ...items];
        }
        else {
            input[name] = coerce(property, flag, value);
        }
    }

    const order = tool.positional ?? [];
    const lastTakesRest = order.length > 0 && properties[order.at(-1) as string]?.type === 'string';

    if (bare.length > order.length && !lastTakesRest) {
        throw new UsageError(`Unexpected ${ bare.slice(order.length).map(word => `"${ word }"`).join(', ') }. ${ order.length > 0 ? `Expected ${ order.map(name => `<${ kebab(name) }>`).join(' ') }` : 'This command takes no bare words; give every value with its option' }`);
    }

    order.forEach((name, position) => {
        const rest = position === order.length - 1 ? bare.slice(position) : bare.slice(position, position + 1);

        if (rest.length === 0) {
            return;
        }

        if (given(name)) {
            throw new UsageError(`${ kebab(name) } is given twice: as a word and as --${ kebab(name) }`);
        }

        const property = properties[name] ?? {};
        const text = property.type === 'string' ? rest.join(' ') : rest[0];

        // Only the text that takes the rest of the words, a message, comes from stdin; a `-` anywhere else is a value like any other.
        if (text === STDIN && property.type === 'string' && position === order.length - 1) {
            fromSource(name, STDIN);
        }
        else {
            input[name] = coerce(property, kebab(name), text);
        }
    });

    const missing = (tool.inputSchema.required ?? []).filter(name => !given(name));

    if (!help && missing.length > 0) {
        throw new UsageError(`Missing ${ missing.map(name => (order.includes(name) ? `<${ kebab(name) }>` : `--${ kebab(name) }`)).join(', ') }. Run it with --help to see the usage`);
    }

    return { arguments: input, files, json, help };
}

/**
 * A tool's text as a command line user reads it: the tools it names by their tool name (`thread_spawn`) become the commands they are
 * (`clowdy thread spawn`).
 */
export function commandText(text: string, tools: readonly Pick<CliTool, 'name'>[]): string {
    return tools.reduce((result, tool) => {
        const { group, command } = commandOf(tool);

        return result.replaceAll(new RegExp(`\\b${ tool.name }\\b`, 'g'), `clowdy ${ group } ${ command }`);
    }, text);
}

/** The longest summary of a command that is kept whole; a longer first sentence is cut at its colon. */
const SUMMARY_CHARS = 100;

/** One line of what a tool does: its first sentence without the parts in brackets, cut at a colon when that is still long. */
export function summaryOf(description: string): string {
    const plain = description.replaceAll(/\s*\([^)]*\)/g, '').replaceAll(/\s+/g, ' ').trim();
    const sentence = (/^.*?\.(?=\s|$)/.exec(plain)?.[0] ?? plain).replace(/\.$/, '');
    const colon = sentence.indexOf(':');

    return sentence.length > SUMMARY_CHARS && colon >= 20 ? sentence.slice(0, colon) : sentence;
}

/** What a flag's value looks like in the help: the choices, a number, a list, a text. */
function placeholder(property: Property): string {
    if (property.enum) {
        return property.enum.join('|');
    }

    switch (property.type) {
        case 'integer':
            return 'n';
        case 'number':
            return 'number';
        case 'array':
            return property.items?.enum ? `${ property.items.enum.join('|') },...` : 'a,b,...';
        default:
            return 'text';
    }
}

const row = (left: string, right: string) => (right ? `  ${ left.padEnd(30) } ${ right }` : `  ${ left }`);

/** The usage text of one command: its line, what it does, its arguments and options, and examples when there are any. */
export function helpOf(tool: CliTool, tools: readonly CliTool[] = [tool], examples: readonly string[] = []): string {
    const { group, command } = commandOf(tool);
    const properties = tool.inputSchema.properties ?? {};
    const required = new Set(tool.inputSchema.required ?? []);
    const order = tool.positional ?? [];
    const text = (value: string | undefined) => commandText(value ?? '', tools);
    const usage = [`clowdy ${ group } ${ command }`, ...order.map(name => (required.has(name) ? `<${ kebab(name) }>` : `[${ kebab(name) }]`)), '[options]'].join(' ');
    const positional = order.map((name, position) => row(`<${ kebab(name) }>`, [text(properties[name]?.description), position === order.length - 1 && properties[name]?.type === 'string' && '(- reads it from stdin)'].filter(Boolean).join(' ')));
    const options = Object.entries(properties).filter(([name]) => !order.includes(name)).flatMap(([name, property]) => {
        const flag = property.type === 'boolean' ? `--${ kebab(name) }` : `--${ kebab(name) } <${ placeholder(property) }>`;
        const note = [text(property.description), property.type === 'array' && '(comma-separated, or the option repeated)', required.has(name) && '(required)'].filter(Boolean).join(' ');

        // A required text is the long one, a brief or a message: it comes from a file or a heredoc more often than not.
        return [row(flag, note), ...(required.has(name) && property.type === 'string' ? [row(`--${ kebab(name) }-file <path>`, `The same from a file; - reads stdin (a heredoc: --${ kebab(name) }-file - <<'EOF')`)] : [])];
    });

    return [
        `Usage: ${ usage }`,
        '',
        text(tool.description),
        ...(positional.length > 0 ? ['', 'Arguments:', ...positional] : []),
        '',
        'Options:',
        ...options,
        row('--json', 'Print the result, or the refusal, as one JSON object'),
        ...(examples.length > 0 ? ['', 'Examples:', ...examples.map(example => `  ${ example }`)] : []),
    ].join('\n');
}
