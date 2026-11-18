import { homedir, tmpdir } from 'node:os';

import { withAppServer } from './appserver';
import { jsonObject } from './claude';
import { runProgram } from './exec';

import type { AgentModel, AgentModels } from '@clowdy/protocol';
import type { AgentRegistry } from '../engine/acp/registry';
import type { ProbeContext } from './types';

const CLAUDE_TIMEOUT_MS = 30_000;
const CODEX_TIMEOUT_MS = 30_000;
const CURSOR_TIMEOUT_MS = 30_000;
/** The list moves with the account and the program's version, not by the minute. */
const FRESH_MS = 10 * 60_000;
const MAX_PAGES = 10;

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/* ---------------------------------- Claude Code --------------------------------- */

/**
 * The picker of Claude Code without a chat: `claude -p --input-format stream-json` answers a `list_models` control request
 * from the program itself (no API turn, nothing saved). The rows follow the account, the provider and the settings.
 */
const CLAUDE_REQUEST = `${ JSON.stringify({ type: 'control_request', request_id: 'clowdy-models', request: { subtype: 'list_models' } }) }\n`;
const CLAUDE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--settings', '{"disableAllHooks":true}'];

/** The `models` of the `control_response` line. A row is Claude's own `ModelInfo`: `value` is an alias the program takes for `--model`, `resolvedModel` the versioned id it stands for. */
export function parseClaudeModels(stdout: string): AgentModel[] | undefined {
    for (const line of stdout.split('\n')) {
        const object = line.trim().startsWith('{') ? jsonObject(line) : undefined;
        const response = object?.type === 'control_response' ? object.response as { subtype?: unknown; response?: { models?: unknown } } | undefined : undefined;

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
            const efforts = row.supportsEffort === true && Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.filter((level): level is string => typeof level === 'string') : [];

            models.push({
                id,
                name: text(row.displayName) ?? id,
                ...(text(row.description) && { description: text(row.description) }),
                ...(id === 'default' && { isDefault: true }),
                ...(resolved && resolved !== id && { resolvedId: resolved }),
                ...(efforts.length > 0 && { efforts }),
                ...(row.supportsFastMode === true && { supportsFast: true }),
            });
        }

        return models;
    }

    return undefined;
}

async function claudeModels(context: ProbeContext): Promise<AgentModels> {
    const run = await runProgram(context.program, CLAUDE_ARGS, { env: context.env, cwd: context.cwd, timeoutMs: CLAUDE_TIMEOUT_MS, input: CLAUDE_REQUEST });

    if (run.error || run.timedOut) {
        return { state: 'error', models: [], detail: run.error ? `Could not start Claude Code: ${ run.error }` : 'Claude Code did not list its models in time' };
    }

    const models = parseClaudeModels(run.stdout);

    // An older Claude Code answers an unknown request with an error and exit code 0.
    return models && models.length > 0
        ? { state: 'ok', models, fetchedAt: context.now() }
        : { state: 'error', models: [], detail: 'Claude Code did not list its models (is it up to date?)' };
}

/* ------------------------------------- Codex ------------------------------------ */

interface CodexModel {
    id?: unknown;
    model?: unknown;
    displayName?: unknown;
    description?: unknown;
    hidden?: unknown;
    isDefault?: unknown;
    defaultReasoningEffort?: unknown;
    supportedReasoningEfforts?: Array<{ reasoningEffort?: unknown }> | null;
    serviceTiers?: Array<{ id?: unknown }> | null;
}

/** A row of `model/list`: `id` is the catalog id a turn takes, the efforts are open strings (`low` to `ultra`), a `priority` service tier is the fast mode. */
export function codexModel(row: CodexModel): AgentModel | undefined {
    const id = text(row.id) ?? text(row.model);

    if (!id || row.hidden === true) {
        return undefined;
    }

    const efforts = (row.supportedReasoningEfforts ?? []).map(effort => text(effort.reasoningEffort)).filter((effort): effort is string => effort !== undefined);

    return {
        id,
        name: text(row.displayName) ?? id,
        ...(text(row.description) && { description: text(row.description) }),
        ...(row.isDefault === true && { isDefault: true }),
        ...(efforts.length > 0 && { efforts }),
        ...(text(row.defaultReasoningEffort) && { defaultEffort: text(row.defaultReasoningEffort) }),
        ...((row.serviceTiers ?? []).some(tier => tier.id === 'priority') && { supportsFast: true }),
    };
}

async function codexModels(context: ProbeContext): Promise<AgentModels> {
    try {
        const models = await withAppServer(context, async (rpc) => {
            await rpc.call('initialize', { clientInfo: { name: 'clowdy', title: 'Clowdy', version: '0' }, capabilities: null });
            rpc.notify('initialized');

            const listed: AgentModel[] = [];
            let cursor: string | null = null;

            for (let page = 0; page < MAX_PAGES; page++) {
                const answer = await rpc.call('model/list', { limit: 100, includeHidden: false, ...(cursor && { cursor }) }) as { data?: CodexModel[]; nextCursor?: string | null };

                listed.push(...(answer.data ?? []).map(codexModel).filter((model): model is AgentModel => model !== undefined));
                cursor = answer.nextCursor ?? null;

                if (!cursor) {
                    break;
                }
            }

            return listed;
        }, CODEX_TIMEOUT_MS);

        return models.length > 0 ? { state: 'ok', models, fetchedAt: context.now() } : { state: 'error', models: [], detail: 'Codex listed no models' };
    }
    catch (error) {
        return { state: 'error', models: [], detail: `Codex did not list its models: ${ error instanceof Error ? error.message : String(error) }` };
    }
}

/* ------------------------------------- Cursor ----------------------------------- */

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

async function cursorModels(context: ProbeContext): Promise<AgentModels> {
    const run = await runProgram(context.program, ['--list-models'], { env: context.env, cwd: context.cwd, timeoutMs: CURSOR_TIMEOUT_MS });

    if (run.error || run.timedOut) {
        return { state: 'error', models: [], detail: run.error ? `Could not start Cursor: ${ run.error }` : 'Cursor did not list its models in time' };
    }

    const models = parseCursorModels(run.stdout);

    return models.length > 0
        ? { state: 'ok', models, fetchedAt: context.now() }
        : { state: 'error', models: [], detail: (run.stderr || run.stdout).trim().split('\n')[0]?.slice(0, 160) || 'Cursor did not list its models (is it signed in?)' };
}

/* ------------------------------------ the catalog ------------------------------- */

/** How each agent lists its models. An agent without a route has no list Clowdy can read. */
export const MODEL_ROUTES: Readonly<Record<string, (context: ProbeContext) => Promise<AgentModels>>> = {
    claude: claudeModels,
    codex: codexModels,
    cursor: cursorModels,
};

export interface ModelCatalogOptions {
    registry: AgentRegistry;
    routes?: typeof MODEL_ROUTES;
    now?: () => number;
    freshMs?: number;
    cwd?: string;
    fetch?: typeof fetch;
    platform?: NodeJS.Platform;
    home?: string;
}

interface Cached {
    at: number;
    models: Promise<AgentModels>;
}

/**
 * The models of each agent, read from the agent's own program the first time somebody asks and kept for ten minutes
 * (a failed read is not kept). Nothing is read in the background and no chat is started, so asking is the only cost.
 */
export class ModelCatalog {
    private cache = new Map<string, Cached>();
    private now: () => number;

    constructor(private options: ModelCatalogOptions) {
        this.now = options.now ?? Date.now;
    }

    async get(id: string): Promise<AgentModels> {
        const route = (this.options.routes ?? MODEL_ROUTES)[id];

        if (!route) {
            return { state: 'unavailable', models: [], detail: `Clowdy cannot list the models of ${ this.options.registry.nameOf(id) } yet` };
        }

        const cached = this.cache.get(id);

        if (cached && this.now() - cached.at < (this.options.freshMs ?? FRESH_MS)) {
            return await cached.models;
        }

        // Kept before the first wait, so callers that ask together share one read.
        const entry = { at: this.now(), models: this.read(id, route) };

        this.cache.set(id, entry);

        const result = await entry.models;

        // A failure is asked again next time.
        if (result.state !== 'ok' && this.cache.get(id) === entry) {
            this.cache.delete(id);
        }

        return result;
    }

    private async read(id: string, route: (context: ProbeContext) => Promise<AgentModels>): Promise<AgentModels> {
        const target = await this.options.registry.probeTarget(id);

        if (!target) {
            return { state: 'unavailable', models: [], detail: `${ this.options.registry.nameOf(id) } is not installed or is switched off in Clowdy` };
        }

        try {
            return await route({
                ...target,
                cwd: this.options.cwd ?? tmpdir(),
                fetch: this.options.fetch ?? fetch,
                now: this.now,
                platform: this.options.platform ?? process.platform,
                home: this.options.home ?? homedir(),
            });
        }
        catch (error) {
            return { state: 'error', models: [], detail: error instanceof Error ? error.message : String(error) };
        }
    }

    /** Forgets what was read, for when the program, the account or the environment changed. */
    forget(id?: string): void {
        if (id === undefined) {
            this.cache.clear();
        }
        else {
            this.cache.delete(id);
        }
    }
}
