import { RpcError, RpcTimeout, withAppServer } from '../appserver';
import { runProgram } from '../exec';
import { text } from '../parse';

import type { AgentModel, AgentModels } from '@clowdy/protocol';
import type { ProbeContext } from '../types';

const CURSOR_TIMEOUT_MS = 30_000;

/** `cursor-agent --list-models`: a header, then `<id> - <Name>` per line, the default marked `(current, default)`, then a tip. An id is a variant that encodes effort, speed and thinking. */
export function parseCursorModels(output: string): AgentModel[] {
    const models: AgentModel[] = [];

    for (const line of output.split('\n')) {
        const match = /^(\S+) - (.+)$/.exec(line.trim());

        if (!match) {
            continue;
        }

        const marker = /\s*\(([^)]*)\)\s*$/.exec(match[2]!);
        const marks = marker ? marker[1]!.split(',').map(mark => mark.trim()) : [];
        const known = marks.length > 0 && marks.every(mark => mark === 'current' || mark === 'default');
        const name = (known ? match[2]!.slice(0, marker!.index) : match[2]!).trim();

        models.push({ id: match[1]!, name, ...(known && marks.includes('default') && { isDefault: true }) });
    }

    return models;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The values a select option offers, groups flattened and repeats dropped. Whatever is not a record with a text `value` is left out. */
function choicesOf(option: Record<string, unknown>): string[] {
    const choices = (Array.isArray(option.options) ? option.options : []).flatMap((choice: unknown) => (isRecord(choice) && Array.isArray(choice.options) ? choice.options as unknown[] : [choice]));

    return [...new Set(choices.flatMap(choice => (isRecord(choice) && text(choice.value) ? [text(choice.value)!] : [])))];
}

/**
 * The answer of `cursor/list_available_models`: one entry per model family, in Cursor's own order (Auto, its own models, then the
 * rest), each with typed options. The effort is the first option of category `thought_level` that offers levels (`thinking` is a switch
 * with `true` and `false`); its id differs per family (`effort`, `reasoning_effort`, `reasoning`), which a run does not need to know: it finds the option by the level.
 * Whatever has an odd shape is left out, never thrown over: a family that repeats an id is kept once (the first).
 */
export function parseCursorFamilies(answer: unknown): AgentModel[] {
    const rows = isRecord(answer) && Array.isArray(answer.models) ? answer.models as unknown[] : [];
    const models = new Map<string, AgentModel>();

    for (const row of rows) {
        const id = isRecord(row) ? text(row.value) : undefined;

        if (!isRecord(row) || !id || models.has(id)) {
            continue;
        }

        const options = (Array.isArray(row.configOptions) ? row.configOptions : []).filter(isRecord);
        const effort = options.flatMap(option => (option.category === 'thought_level' && option.type === 'select' ? [{ option, levels: choicesOf(option) }] : []))
            .find(({ levels }) => levels.length > 0 && !levels.includes('true') && !levels.includes('false'));
        const fallback = text(effort?.option.currentValue);

        models.set(id, {
            id,
            name: text(row.name) ?? id,
            ...(id === 'default' && { isDefault: true }),
            ...(effort && { efforts: effort.levels, ...(fallback && effort.levels.includes(fallback) && { defaultEffort: fallback }) }),
            ...(options.some(option => option.id === 'fast') && { supportsFast: true }),
        });
    }

    return [...models.values()];
}

/** ACP's JSON-RPC code for "authentication required", and the words of a program that says it without one. */
const AUTH_REQUIRED = -32000;
const NOT_SIGNED_IN = /authentication required|not (?:logged|signed) in|log ?in first/i;

/** Cursor's own list over ACP: `initialize`, then the vendor method. Rejects with what failed (`RpcError`, `RpcTimeout`, or the program ending). */
async function cursorFamilies(context: ProbeContext, timeoutMs: number): Promise<AgentModel[]> {
    return await withAppServer(context, async (rpc) => {
        await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'clowdy', title: 'Clowdy', version: '0' } });

        return parseCursorFamilies(await rpc.call('cursor/list_available_models'));
    }, timeoutMs, ['acp']);
}

/**
 * Cursor's models: the families of `cursor/list_available_models` over ACP; a Cursor that cannot (it ends on `acp`, refuses the method, or
 * lists nothing) is read with `--list-models`. Two answers end the read at once, because the old list would only repeat them after a second
 * process: a Cursor that is signed out says so, and one that did not answer in time is as slow for the old list (one deadline, not two).
 */
export async function cursorModels(context: ProbeContext, timeoutMs = CURSOR_TIMEOUT_MS): Promise<AgentModels> {
    try {
        const families = await cursorFamilies(context, timeoutMs);

        if (families.length > 0) {
            return { state: 'ok', models: families, fetchedAt: context.now() };
        }
    }
    catch (error) {
        if (error instanceof RpcError && (error.code === AUTH_REQUIRED || NOT_SIGNED_IN.test(error.message))) {
            return { state: 'error', models: [], detail: 'Cursor is not signed in. Sign in on the Providers page, then try again.' };
        }

        if (error instanceof RpcTimeout) {
            return { state: 'error', models: [], detail: 'Cursor did not list its models in time' };
        }
    }

    const run = await runProgram(context.program, ['--list-models'], { env: context.env, cwd: context.cwd, timeoutMs, signal: context.signal });

    if (run.error || run.timedOut) {
        return { state: 'error', models: [], detail: run.error ? `Could not start Cursor: ${ run.error }` : 'Cursor did not list its models in time' };
    }

    const models = parseCursorModels(run.stdout);

    return models.length > 0
        ? { state: 'ok', models, fetchedAt: context.now() }
        : { state: 'error', models: [], detail: (run.stderr || run.stdout).trim().split('\n')[0]?.slice(0, 160) || 'Cursor did not list its models (is it signed in?)' };
}
