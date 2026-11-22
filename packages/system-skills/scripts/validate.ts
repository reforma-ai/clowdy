/**
 * Lints the system skills the way the strictest engine reads them (Codex requires `description`, Claude HTML-escapes it).
 *
 * Per skill folder `skills/<name>/SKILL.md`: front matter with `name` equal to the folder, a one-line `description`, only the
 * allowed keys, a body under the size cap, links that resolve, no orphaned `references/` files, no engine-specific syntax,
 * no tool the agents do not have, and no `clowdy task` or `clowdy thread` command the daemon does not have.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const skillsDir = path.join(root, 'skills');
const MAX_BODY_BYTES = 24_000;
const MAX_DESCRIPTION_CHARS = 1_000;
const ALLOWED_KEYS = new Set(['name', 'description', 'allowed-tools']);

/** The Clowdy tools an agent may be told to call (bare names; the harness adds the MCP prefix). Tasks and threads are shell commands, not tools. */
const TOOLS = new Set([
    'ask_user',
]);
/**
 * The commands of `clowdy task` an agent may be told to run in its shell. They are the daemon's task tools marked as shell commands, which no skill
 * names as tools (`task_get` is caught below); `apps/daemon/test/skills-vocabulary.test.ts` checks this list against the daemon.
 */
const TASK_COMMANDS = new Set([
    'get',
    'list',
    'create',
    'update',
    'comment',
    'comments',
    'archive',
    'unarchive',
]);
/** The commands of `clowdy thread`, the daemon's thread tools marked as shell commands; checked against the daemon like `TASK_COMMANDS`. */
const THREAD_COMMANDS = new Set([
    'spawn',
    'tell',
    'stop',
    'wait',
    'output',
    'log',
    'list',
]);
const COMMANDS: Record<string, ReadonlySet<string>> = { task: TASK_COMMANDS, thread: THREAD_COMMANDS };
/** A snake_case word that looks like a tool name but is not one of ours. */
const TOOL_LIKE = /^(task|run|ask|report|thread|spawn|wait|create|update|list|cancel|get|merge|git|worktree)_[a-z_]+$/;
const FORBIDDEN: Array<[RegExp, string]> = [
    [/mcp__/, 'name tools by their bare name, not `mcp__...`'],
    [/\$ARGUMENTS|\$\{CLAUDE_|!`/, 'Claude-only substitution syntax (Codex leaves it literal)'],
    [/context:\s*fork/, '`context: fork` is not supported by Codex'],
    [/merge queue|integration branch/i, 'the daemon has no git machinery'],
    [/\bexecutors?\b|\bverifiers?\b|child runs?|spawned runs?|waiting_children/i, 'spawned runs are gone: the orchestrator works itself or with the engine\'s own sub-agents'],
    [/\blinear\b/i, 'external trackers are out of scope for the skills'],
    [/--append\b/, '`clowdy task update` has no --append: leave a note as a comment (`clowdy task comment <key> <text>`)'],
];

const problems: string[] = [];
const manifest = JSON.parse(readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8')) as { name?: string };

if (manifest.name !== 'clowdy') problems.push('.claude-plugin/plugin.json: name must be "clowdy" (it is the namespace of every skill)');

const names = readdirSync(skillsDir).filter(entry => statSync(path.join(skillsDir, entry)).isDirectory());

if (names.length === 0) problems.push('skills/: no skills found');

/** Markdown files under a directory, as paths relative to it. */
function listMarkdown(directory: string, prefix = ''): string[] {
    if (!existsSync(directory)) return [];

    return readdirSync(directory).flatMap((entry) => {
        const relative = path.posix.join(prefix, entry);

        return statSync(path.join(directory, entry)).isDirectory()
            ? listMarkdown(path.join(directory, entry), relative)
            : relative.endsWith('.md') ? [relative] : [];
    });
}

/** Relative link targets of a Markdown text, without anchors. Links inside code fences and code spans are examples, not links. */
function linksOf(text: string): string[] {
    const prose = text.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');

    return [...prose.matchAll(/\]\((?!https?:|#)([^)\s]+)\)/g)].map(match => match[1].split('#')[0]);
}

/** Problems in text that an agent will read: invented tools and commands, and syntax the engines do not share. */
function lintText(label: string, text: string) {
    for (const [pattern, reason] of FORBIDDEN) {
        if (pattern.test(text)) problems.push(`${ label }: ${ reason }`);
    }

    for (const match of text.matchAll(/`([a-z]+(?:_[a-z]+)+)(?:\(|`)/g)) {
        if (TOOL_LIKE.test(match[1]) && !TOOLS.has(match[1])) problems.push(`${ label }: \`${ match[1] }\` is not a Clowdy tool (tasks and threads are shell commands: \`clowdy task get\`, \`clowdy thread spawn\`)`);
    }

    for (const [, group, command] of text.matchAll(/\bclowdy (task|thread) ([a-z][a-z-]*)/g)) {
        if (!COMMANDS[group].has(command)) problems.push(`${ label }: \`clowdy ${ group } ${ command }\` is not a command (${ [...COMMANDS[group]].join(', ') })`);
    }
}

for (const name of names) {
    const skillDir = path.join(skillsDir, name);
    const file = path.join(skillDir, 'SKILL.md');
    const label = `skills/${ name }/SKILL.md`;

    if (!existsSync(file)) {
        problems.push(`skills/${ name }: SKILL.md is missing`);
        continue;
    }

    const text = readFileSync(file, 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);

    if (!match) {
        problems.push(`${ label }: front matter is missing`);
        continue;
    }

    const [, frontMatter, body] = match;
    const field = (key: string) => new RegExp(`^${ key }:\\s*(.*)$`, 'm').exec(frontMatter)?.[1]?.trim().replace(/^["']|["']$/g, '');

    for (const line of frontMatter.split('\n')) {
        const key = /^([a-z-]+):/.exec(line)?.[1];

        if (!key) problems.push(`${ label }: front matter line is not "key: value" (keep every value on one line): ${ line.slice(0, 40) }`);
        else if (!ALLOWED_KEYS.has(key)) problems.push(`${ label }: front matter key "${ key }" is not allowed (use ${ [...ALLOWED_KEYS].join(', ') })`);
    }

    if (!/^[a-z0-9-]{1,64}$/.test(name)) problems.push(`${ label }: folder name must be lowercase letters, digits and hyphens, at most 64 characters`);
    if (field('name') !== name) problems.push(`${ label }: name must equal the folder name`);

    const description = field('description');

    if (!description) problems.push(`${ label }: description is required`);
    else if (description.length > MAX_DESCRIPTION_CHARS) problems.push(`${ label }: description is over ${ MAX_DESCRIPTION_CHARS } characters`);
    else if (/[<>]/.test(description)) problems.push(`${ label }: description must not contain < or > (Claude HTML-escapes them)`);

    if (Buffer.byteLength(body) > MAX_BODY_BYTES) problems.push(`${ label }: body is over ${ MAX_BODY_BYTES } bytes; move detail into references/`);

    lintText(label, body);

    for (const link of linksOf(body)) {
        if (!existsSync(path.join(skillDir, link))) problems.push(`${ label }: broken link ${ link }`);
    }

    const references = listMarkdown(path.join(skillDir, 'references')).map(relative => `references/${ relative }`);
    const linked = new Set(linksOf(body));

    for (const reference of references) {
        const referenceText = readFileSync(path.join(skillDir, reference), 'utf8');

        lintText(`skills/${ name }/${ reference }`, referenceText);

        for (const link of linksOf(referenceText)) {
            if (!existsSync(path.join(skillDir, path.dirname(reference), link))) problems.push(`skills/${ name }/${ reference }: broken link ${ link }`);
            else linked.add(path.posix.normalize(path.posix.join(path.dirname(reference), link)));
        }
    }

    for (const reference of references) {
        if (!linked.has(reference)) problems.push(`skills/${ name }/${ reference }: not linked from SKILL.md or another reference, so no agent will find it`);
    }
}

if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
}

console.log(`${ names.length } skills OK: ${ names.join(', ') }`);
