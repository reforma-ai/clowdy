import { browserStorage, readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

import type { AgentModel } from '@clowdy/protocol';

/** What a chat runs on, as the picker holds it: the agent's id, a model of it and a reasoning level of that model, in the agent's own spelling. */
export interface ModelChoice {
    engine: string;
    model?: string;
    effort?: string;
}

/** What the person last picked on this machine, so a new chat starts where the last one left off. */
export interface RememberedChoice {
    /** The provider of the last pick. */
    engine?: string;
    /** The last model of each provider. */
    models: Record<string, string>;
    /** The last reasoning level of each model, under `provider/model`. */
    efforts: Record<string, string>;
}

const STORAGE_KEY = 'clowdy:model-choice';

const levelKey = (engine: string, model: string) => `${ engine }/${ model }`;

/** An own entry of a stored record: a provider named `constructor` or `toString` must not find what every object inherits. */
const own = (record: Record<string, string>, key: string): string | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

const lastEffort = (remembered: RememberedChoice, engine: string, model: string) => own(remembered.efforts, levelKey(engine, model));

const strings = (value: unknown): Record<string, string> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {}
);

/** What was stored, or nothing remembered when there is none or it is not what we wrote. */
export function readRemembered(storage: KeyValueStorage | undefined = browserStorage()): RememberedChoice {
    const stored = readStored(storage, STORAGE_KEY);
    const record = typeof stored === 'object' && stored !== null ? stored as Record<string, unknown> : {};

    return { ...(typeof record.engine === 'string' && { engine: record.engine }), models: strings(record.models), efforts: strings(record.efforts) };
}

export function writeRemembered(remembered: RememberedChoice, storage: KeyValueStorage | undefined = browserStorage()): void {
    writeStored(storage, STORAGE_KEY, remembered);
}

/** The memory after the person picked `choice`: the provider, its model, and the model's level (a model with no level keeps what it had). */
export function remember(remembered: RememberedChoice, choice: ModelChoice): RememberedChoice {
    const { model, effort } = choice;

    return {
        engine: choice.engine,
        models: model ? { ...remembered.models, [choice.engine]: model } : remembered.models,
        efforts: model && effort ? { ...remembered.efforts, [levelKey(choice.engine, model)]: effort } : remembered.efforts,
    };
}

/** The label of a reasoning level, from the agent's own spelling (`xhigh`, `extra-high`, `max`, `ultra`, `none`, `minimal`, anything it adds). */
export function levelLabel(level: string): string {
    if (level.toLowerCase() === 'xhigh') return 'Extra high';

    const words = level.replace(/[-_]+/g, ' ').trim();

    // A level made of separators alone has no words: it is shown as the agent spells it.
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : level;
}

/**
 * The models to offer. Claude Code lists a "Default (recommended)" row that is the model another row names too (`opus`): the pair is shown
 * once, as the first row that names that model, still the default. A default row that names nothing else (Cursor's "Auto") stays.
 */
export function pickableModels(models: readonly AgentModel[]): AgentModel[] {
    const duplicates = new Map<AgentModel, AgentModel>();

    for (const model of models) {
        const { resolvedId } = model;

        if (!model.isDefault || !resolvedId) continue;

        // A row that is itself a duplicate is not what another one stands for: two defaults that name the same model leave one.
        const named = models.find(other => other !== model && !duplicates.has(other) && (other.resolvedId === resolvedId || other.id === resolvedId));

        if (named) duplicates.set(model, named);
    }

    if (duplicates.size === 0) return [...models];

    const stood = new Set(duplicates.values());

    return models.flatMap(model => (duplicates.has(model) ? [] : [stood.has(model) ? { ...model, isDefault: true } : model]));
}

/** The model a new chat starts on when nothing was picked: the one the agent marks as its default, else the first. */
export function defaultModel(models: readonly AgentModel[]): AgentModel | undefined {
    return models.find(model => model.isDefault) ?? models[0];
}

/** The level a model starts on: the one it names, else `high` when it has it, else the middle one. */
export function defaultEffort(model: AgentModel): string | undefined {
    const levels = model.efforts ?? [];

    if (model.defaultEffort && levels.includes(model.defaultEffort)) return model.defaultEffort;

    return levels.includes('high') ? 'high' : levels[Math.floor(levels.length / 2)];
}

/**
 * What the picker holds after the person picked `model` of `engine`: the level they last used on it, else the one they had if the model
 * offers it, else the model's own default. A model with no levels has none.
 */
export function choiceForModel(engine: string, model: AgentModel, current: string | undefined, remembered: RememberedChoice): ModelChoice {
    const levels = model.efforts ?? [];
    const effort = [lastEffort(remembered, engine, model.id), current].find((level): level is string => level !== undefined && levels.includes(level)) ?? defaultEffort(model);

    return { engine, model: model.id, ...(effort && { effort }) };
}

/**
 * Where a new chat starts, given the models of its provider: the model the person last used there if the agent still offers it, else the
 * agent's default, with the level of `choiceForModel`. With no list to choose from (still loading, or the agent cannot list) the memory is returned as it is.
 */
export function startingChoice(engine: string, models: readonly AgentModel[], remembered: RememberedChoice): ModelChoice {
    const list = pickableModels(models);
    const last = own(remembered.models, engine);
    const model = list.find(candidate => candidate.id === last) ?? defaultModel(list);

    if (!model) {
        const effort = last && lastEffort(remembered, engine, last);

        return { engine, ...(last && { model: last }), ...(effort && { effort }) };
    }

    return choiceForModel(engine, model, undefined, remembered);
}

/** The provider a new chat starts on: the one last picked if it can still be used, else the first that can. */
export function startingEngine(usable: readonly string[], remembered: RememberedChoice): string | undefined {
    return remembered.engine && usable.includes(remembered.engine) ? remembered.engine : usable[0];
}
