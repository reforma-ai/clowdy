import { runProgram } from '../../process/run';
import { jsonObject, text } from '../parse';

import type { AgentModel, AgentModels } from '@clowdy/protocol';
import type { ProbeContext } from '../types';

const CLAUDE_TIMEOUT_MS = 30_000;

/**
 * The picker of Claude Code without a chat: `claude -p --input-format stream-json` answers a `list_models` control request
 * from the program itself (no API turn, nothing saved). The rows follow the account, the provider and the settings.
 */
const CLAUDE_REQUEST = `${JSON.stringify({ type: 'control_request', request_id: 'clowdy-models', request: { subtype: 'list_models' } })}\n`;
const CLAUDE_ARGS = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--settings',
    '{"disableAllHooks":true}',
];

/** The `models` of the `control_response` line. A row is Claude's own `ModelInfo`: `value` is an alias the program takes for `--model`, `resolvedModel` the versioned id it stands for. */
export function parseClaudeModels(stdout: string): AgentModel[] | undefined {
    for (const line of stdout.split('\n')) {
        const object = line.trim().startsWith('{') ? jsonObject(line) : undefined;
        const response =
            object?.type === 'control_response'
                ? (object.response as { subtype?: unknown; response?: { models?: unknown } } | undefined)
                : undefined;

        if (response?.subtype !== 'success' || !Array.isArray(response.response?.models)) {
            continue;
        }

        const models: AgentModel[] = [];

        for (const row of response.response.models as Array<Record<string, unknown>>) {
            const id = text(row?.value);

            // A disabled row is a placeholder (an update is needed): it must not reach `--model`.
            if (!id || row.disabled === true) {
                continue;
            }

            const resolved = text(row.resolvedModel);
            const efforts =
                row.supportsEffort === true && Array.isArray(row.supportedEffortLevels)
                    ? row.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
                    : [];

            models.push({
                id,
                name: text(row.displayName) ?? id,
                ...(text(row.description) && { description: text(row.description) }),
                ...(id === 'default' && { isDefault: true }),
                ...(resolved && resolved !== id && { resolvedId: resolved, featured: true }),
                ...(efforts.length > 0 && { efforts }),
                ...(row.supportsFastMode === true && { supportsFast: true }),
            });
        }

        return models;
    }

    return undefined;
}

/** What Claude Code answered to the request when it did not list models: the text of its `control_response` error. */
export function claudeModelsError(stdout: string): string | undefined {
    for (const line of stdout.split('\n')) {
        const object = line.trim().startsWith('{') ? jsonObject(line) : undefined;
        const response =
            object?.type === 'control_response'
                ? (object.response as { subtype?: unknown; error?: unknown } | undefined)
                : undefined;

        if (response?.subtype === 'error' && text(response.error)) {
            return text(response.error);
        }
    }

    return undefined;
}

/** Why no models came back, in the program's own words, and for a Claude Code that does not know the request, which one it is and that it needs an update. */
function claudeModelsFailure(run: { stdout: string; stderr: string }, program: string): string {
    const said = claudeModelsError(run.stdout);

    // An older Claude Code answers an unknown request with an error and exit code 0.
    if (said && /unsupported control request/i.test(said)) {
        return `Claude Code at ${program} is too old to list its models. Update it, then try again`;
    }

    const reason = said ?? run.stderr.trim().split('\n')[0]?.slice(0, 160);

    return reason ? `Claude Code could not list its models: ${reason}` : 'Claude Code listed no models';
}

export async function claudeModels(context: ProbeContext): Promise<AgentModels> {
    const run = await runProgram(context.program, CLAUDE_ARGS, {
        env: context.env,
        cwd: context.cwd,
        timeoutMs: CLAUDE_TIMEOUT_MS,
        input: CLAUDE_REQUEST,
        signal: context.signal,
    });

    if (run.error || run.timedOut) {
        return {
            state: 'error',
            models: [],
            detail: run.error
                ? `Could not start Claude Code: ${run.error}`
                : 'Claude Code did not list its models in time',
        };
    }

    const models = parseClaudeModels(run.stdout);

    return models && models.length > 0
        ? { state: 'ok', models, fetchedAt: context.now() }
        : { state: 'error', models: [], detail: claudeModelsFailure(run, context.program) };
}
