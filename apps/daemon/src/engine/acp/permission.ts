import type { ApprovalDecision, ApprovalSubject } from '@clowdy/protocol';
import type { ApprovalRequest } from '../types';

/** One option an agent offers in a permission request. */
export interface PermissionOption {
    optionId: string;
    kind: string;
}

/**
 * The parts of an agent's `session/request_permission` the daemon reads. Both protocol layers send the same shape, so the host takes it as it
 * comes, and nothing here depends on an SDK type.
 */
export interface PermissionParams {
    toolCall: {
        toolCallId?: string;
        title?: string | null;
        kind?: string | null;
        name?: string | null;
        rawInput?: unknown;
        locations?: readonly { path: string }[] | null;
        content?: readonly unknown[] | null;
        _meta?: unknown;
    };
    options: readonly PermissionOption[];
}

/** The longest text of an input that a card is given as detail. */
const DETAIL_CHARS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

/** The first of `keys` that holds text in `input`. */
const firstText = (input: unknown, keys: string[]): string | undefined => (isRecord(input) ? keys.map(key => text(input[key])).find(found => found !== undefined) : undefined);

/** The command an input names: text, or a list of words (an argument vector) that is joined. */
function commandOf(input: unknown): string | undefined {
    if (text(input)) {
        return (input as string).trim();
    }

    if (!isRecord(input)) {
        return undefined;
    }

    for (const key of ['command', 'cmd']) {
        const value = input[key];

        if (Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string')) {
            return value.join(' ');
        }

        if (text(value)) {
            return (value as string).trim();
        }
    }

    return undefined;
}

/** The files a diff in a call's content is about: its own `path` (version 1), or the paths of its `changes` (version 2: a move names the old path and the new). */
function diffPaths(entry: unknown): (string | undefined)[] {
    if (!isRecord(entry) || entry.type !== 'diff') {
        return [];
    }

    const changes = Array.isArray(entry.changes) ? entry.changes.filter(isRecord).flatMap(change => [text(change.oldPath), text(change.path)]) : [];

    return [text(entry.path), ...changes];
}

/** The paths a change names: the call's own locations, the files its diffs are about, and the path of its input. Each once, in the order met. */
function pathsOf({ locations, content, rawInput }: PermissionParams['toolCall']): string[] {
    const found = [
        ...(locations ?? []).map(location => text(location?.path)),
        ...(content ?? []).flatMap(diffPaths),
        firstText(rawInput, ['file_path', 'filePath', 'path']),
    ];

    return [...new Set(found.filter((path): path is string => path !== undefined))];
}

/** The tool's own name when the agent gives one (an ACP `name`, or Claude's adapter in `_meta.claudeCode.toolName`), else the call's title. */
function toolOf(call: PermissionParams['toolCall']): string {
    const claude = isRecord(call._meta) && isRecord(call._meta.claudeCode) ? text(call._meta.claudeCode.toolName) : undefined;

    return text(call.name) ?? claude ?? text(call.title) ?? 'tool';
}

/** A short text of an input, for a card to show under the tool's name; nothing when there is none or it is long. */
function detailOf(input: unknown): string | undefined {
    const shown = typeof input === 'string' ? input.trim() : input === undefined || input === null ? '' : JSON.stringify(input);

    return shown && shown !== '{}' && shown.length <= DETAIL_CHARS ? shown : undefined;
}

/** What the agent asks to do, put as one of three kinds so a card needs no knowledge of the agent: a command, a change to files, or any other tool. */
function subjectOf(call: PermissionParams['toolCall']): ApprovalSubject {
    if (call.kind === 'execute') {
        const command = commandOf(call.rawInput) ?? text(call.title);

        if (command) {
            const cwd = firstText(call.rawInput, ['cwd', 'workdir']);

            return { kind: 'command', command, ...(cwd && { cwd }) };
        }
    }

    if (call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move') {
        const paths = pathsOf(call);

        if (paths.length > 0) {
            return { kind: 'file_change', paths };
        }
    }

    const detail = detailOf(call.rawInput);

    return { kind: 'tool_use', tool: toolOf(call), ...(detail && { detail }) };
}

/** What a grant is keyed by: the same key is the same thing asked again, whatever call carried it. */
function keyOf(subject: ApprovalSubject, title: string): string {
    switch (subject.kind) {
        case 'command':
            return `command:${ subject.command }`;
        case 'file_change':
            return `file:${ [...subject.paths].sort().join('\n') }`;
        case 'tool_use':
            return `tool:${ subject.tool }:${ title }`;
    }
}

/**
 * The answers a request can be given: `reject` stands for both of the agent's refusals, and `allow_always` (Allow for session) is Clowdy's own grant, so
 * it is offered whenever the agent offers any allow option, whether or not it has a lasting one of its own.
 */
function decisionsOf(options: readonly PermissionOption[]): ApprovalDecision[] {
    const kinds = new Set(options.map(option => option.kind));
    const allows = kinds.has('allow_once') || kinds.has('allow_always');

    return [
        ...(kinds.has('allow_once') ? ['allow_once' as const] : []),
        ...(allows ? ['allow_always' as const] : []),
        ...(kinds.has('reject_once') || kinds.has('reject_always') ? ['reject' as const] : []),
    ];
}

/**
 * A version 2 request, which has no tool call of its own: it says what it is about in a `subject`, either a tool call or a command, and a `title` for the
 * prompt. Read as the version 1 shape the classifier takes.
 */
export function paramsOfV2({ title, subject, options }: { title: string; subject?: unknown; options: readonly PermissionOption[] }): PermissionParams {
    if (isRecord(subject) && subject.type === 'tool_call' && isRecord(subject.toolCall)) {
        const call = subject.toolCall as PermissionParams['toolCall'];

        return { toolCall: { ...call, title: text(call.title) ?? title }, options };
    }

    if (isRecord(subject) && subject.type === 'command' && text(subject.command)) {
        return { toolCall: { ...(text(subject.toolCallId) && { toolCallId: subject.toolCallId as string }), title, kind: 'execute', rawInput: { command: subject.command, cwd: subject.cwd } }, options };
    }

    return { toolCall: { title }, options };
}

/** A permission request as the run puts it to the person. */
export function classify({ toolCall, options }: PermissionParams): ApprovalRequest {
    const subject = subjectOf(toolCall);
    const title = text(toolCall.title) ?? (subject.kind === 'command' ? subject.command : subject.kind === 'tool_use' ? subject.tool : 'Change files');

    return {
        ...(toolCall.toolCallId && { toolCallId: toolCall.toolCallId }),
        title,
        subject,
        decisions: decisionsOf(options),
        key: keyOf(subject, title),
    };
}

/** The kinds of option that answer a decision, best first: a missing one-time option is made up for by the lasting one and the other way round, a refusal by either refusal. */
const KINDS: Record<ApprovalDecision, string[]> = {
    allow_once: ['allow_once', 'allow_always'],
    allow_always: ['allow_always', 'allow_once'],
    reject: ['reject_once', 'reject_always'],
};

/** The option that answers `decision`: the agent's first of the kind. `undefined` when it has none that fits, which the agent is told as a cancel. */
export function optionFor(options: readonly PermissionOption[], decision: ApprovalDecision): string | undefined {
    for (const kind of KINDS[decision]) {
        const option = options.find(candidate => candidate.kind === kind);

        if (option) {
            return option.optionId;
        }
    }

    return undefined;
}
