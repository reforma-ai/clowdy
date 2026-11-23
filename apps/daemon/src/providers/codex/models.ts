import { withAppServer } from '../appserver';
import { text } from '../parse';

import type { AgentModel, AgentModels } from '@clowdy/protocol';
import type { ProbeContext } from '../types';

const CODEX_TIMEOUT_MS = 30_000;
const MAX_PAGES = 10;

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

export async function codexModels(context: ProbeContext): Promise<AgentModels> {
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
