import { describe, expect, it } from 'vitest';

import { choiceForModel, defaultEffort, defaultModel, legalEffort, levelLabel, mainModels, modelRow, moreModels, pickableModels, readRemembered, remember, startingChoice, startingEngine, writeRemembered, type RememberedChoice } from './modelSelection';

import type { AgentModel } from '@clowdy/protocol';

const NOTHING: RememberedChoice = { models: {}, efforts: {} };
const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const claude: AgentModel[] = [
    { id: 'default', name: 'Default (recommended)', isDefault: true, resolvedId: 'claude-opus-5-5', efforts: CLAUDE_LEVELS },
    { id: 'opus', name: 'Opus 5.5', resolvedId: 'claude-opus-5-5', efforts: CLAUDE_LEVELS },
    { id: 'sonnet', name: 'Sonnet 5.5', resolvedId: 'claude-sonnet-5-5', efforts: CLAUDE_LEVELS },
    { id: 'claude-opus-4-6', name: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'haiku-4-5', name: 'Haiku 4.5' },
];

const store = (initial?: string) => {
    const values = new Map<string, string>(initial === undefined ? [] : [['clowdy:model-choice', initial]]);

    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe('levelLabel', () => {
    it('spells every level the agents use', () => {
        expect(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max', 'ultra'].map(levelLabel)).toEqual([
            'None', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Extra high', 'Max', 'Ultra',
        ]);
    });

    it('capitalises a level it has never seen, turning separators into spaces', () => {
        expect(levelLabel('ultra_plus')).toBe('Ultra plus');
        expect(levelLabel('XHIGH')).toBe('Extra high');
        expect(levelLabel('-low-')).toBe('Low');
    });

    it('never gives a label that is empty: a level made of separators is shown as the agent spells it', () => {
        expect(['-', '__', ''].map(levelLabel)).toEqual(['-', '__', '']);
    });
});

describe('pickableModels', () => {
    it('shows the pair of Claude\'s default row and the model it stands for once, as that model, still the default', () => {
        const models = pickableModels(claude);

        expect(models.map(model => model.id)).toEqual(['opus', 'sonnet', 'claude-opus-4-6', 'haiku-4-5']);
        expect(models[0]).toMatchObject({ name: 'Opus 5.5', isDefault: true });
        expect(defaultModel(models)?.id).toBe('opus');
    });

    it('keeps a default row that is a model of its own, like Cursor\'s Auto', () => {
        const cursor: AgentModel[] = [{ id: 'default', name: 'Auto', isDefault: true }, { id: 'gpt-5.5', name: 'GPT-5.5' }];

        expect(pickableModels(cursor)).toEqual(cursor);
        expect(pickableModels([])).toEqual([]);
    });

    it('marks one row as the default when several share the model the default row stands for', () => {
        const models = pickableModels([
            { id: 'default', name: 'Default (recommended)', isDefault: true, resolvedId: 'claude-opus-5-5' },
            { id: 'opus', name: 'Opus 5.5', resolvedId: 'claude-opus-5-5' },
            { id: 'opus-latest', name: 'Opus latest', resolvedId: 'claude-opus-5-5' },
            { id: 'sonnet', name: 'Sonnet 5.5', resolvedId: 'claude-sonnet-5-5' },
        ]);

        expect(models.map(model => [model.id, model.isDefault ?? false])).toEqual([['opus', true], ['opus-latest', false], ['sonnet', false]]);
    });

    it('finds the model the default row stands for by its id when that row has no resolved id of its own', () => {
        const models = pickableModels([
            { id: 'default', name: 'Default (recommended)', isDefault: true, resolvedId: 'claude-opus-4-6' },
            { id: 'sonnet', name: 'Sonnet 5.5', resolvedId: 'claude-sonnet-5-5' },
            { id: 'claude-opus-4-6', name: 'Opus 4.6' },
        ]);

        expect(models.map(model => [model.id, model.isDefault ?? false])).toEqual([['sonnet', false], ['claude-opus-4-6', true]]);
    });

    it('does not remove both of two default rows that name the same model', () => {
        const models = pickableModels([
            { id: 'default', name: 'Default (recommended)', isDefault: true, resolvedId: 'claude-opus-5-5' },
            { id: 'recommended', name: 'Recommended', isDefault: true, resolvedId: 'claude-opus-5-5' },
            { id: 'sonnet', name: 'Sonnet 5.5', resolvedId: 'claude-sonnet-5-5' },
        ]);

        expect(models.map(model => model.id)).toEqual(['recommended', 'sonnet']);
        expect(defaultModel(models)?.id).toBe('recommended');
    });

    it('leaves the rows it was given as they were', () => {
        const rows = structuredClone(claude);

        pickableModels(rows);

        expect(rows).toEqual(claude);
    });
});

describe('defaultEffort', () => {
    it('is the level the model names when it offers it', () => {
        expect(defaultEffort({ id: 'm', name: 'M', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })).toBe('medium');
    });

    it('is high when there is no named default, else the middle level, and nothing for a model with no levels', () => {
        expect(defaultEffort({ id: 'm', name: 'M', efforts: CLAUDE_LEVELS })).toBe('high');
        expect(defaultEffort({ id: 'm', name: 'M', efforts: ['low', 'medium', 'xhigh', 'max'] })).toBe('xhigh');
        expect(defaultEffort({ id: 'm', name: 'M', efforts: ['only'] })).toBe('only');
        expect(defaultEffort({ id: 'm', name: 'M', efforts: ['none', 'low'], defaultEffort: 'gone' })).toBe('low');
        expect(defaultEffort({ id: 'm', name: 'M' })).toBeUndefined();
    });

    it('is nothing for a list that is empty even when the model names a default, and the upper middle one of an even list without high', () => {
        expect(defaultEffort({ id: 'm', name: 'M', efforts: [], defaultEffort: 'high' })).toBeUndefined();
        expect(defaultEffort({ id: 'm', name: 'M', efforts: ['low', 'max'] })).toBe('max');
        expect(defaultEffort({ id: 'm', name: 'M', efforts: ['none'], defaultEffort: 'high' })).toBe('none');
    });
});

describe('legalEffort', () => {
    const model: AgentModel = { id: 'm', name: 'M', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };

    it('is the level when the model offers it', () => {
        expect(legalEffort(model, 'low')).toBe('low');
        expect(legalEffort(model, 'high')).toBe('high');
    });

    it('is the model\'s own default for a level it does not offer, and for none', () => {
        expect(legalEffort(model, 'xhigh')).toBe('medium');
        expect(legalEffort(model, undefined)).toBe('medium');
        expect(legalEffort({ ...model, defaultEffort: undefined }, 'max')).toBe('high');
    });

    it('is nothing for a model with no levels, whatever level it is given', () => {
        expect(legalEffort({ id: 'm', name: 'M' }, 'high')).toBeUndefined();
        expect(legalEffort({ id: 'm', name: 'M', efforts: [] }, 'high')).toBeUndefined();
    });
});

describe('mainModels and moreModels', () => {
    const named = (...ids: string[]): AgentModel[] => ids.map(id => ({ id, name: id.toUpperCase() }));
    const ids = (models: readonly AgentModel[]) => models.map(model => model.id);

    it('are the first five in the agent\'s own order when it marks none as featured', () => {
        const models = named('a', 'b', 'c', 'd', 'e', 'f', 'g');

        expect(ids(mainModels(models))).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(ids(moreModels(models))).toEqual(['f', 'g']);
    });

    it('keep every row of a list of five or fewer as main, and leave nothing behind "More models"', () => {
        expect(ids(mainModels(named('a', 'b')))).toEqual(['a', 'b']);
        expect(ids(moreModels(named('a', 'b')))).toEqual([]);
        expect(ids(mainModels(named('a', 'b', 'c', 'd', 'e')))).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(ids(moreModels(named('a', 'b', 'c', 'd', 'e')))).toEqual([]);
        expect(mainModels([])).toEqual([]);
        expect(moreModels([])).toEqual([]);
    });

    it('are the featured rows when any row is featured, however many or few, and in the agent\'s order', () => {
        const featured = (id: string, on = true): AgentModel => ({ id, name: id, ...(on && { featured: true }) });
        const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => featured(id));

        expect(ids(mainModels(many))).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
        expect(ids(moreModels(many))).toEqual([]);

        const some = [featured('a', false), featured('b'), featured('c', false), featured('d'), featured('e', false), featured('f', false), featured('g', false)];

        expect(ids(mainModels(some))).toEqual(['b', 'd']);
        expect(ids(moreModels(some))).toEqual(['a', 'c', 'e', 'f', 'g']);
    });

    it('add the model in force after the main ones when it is not one of them, and not twice when it is', () => {
        const models = named('a', 'b', 'c', 'd', 'e', 'f', 'g');

        expect(ids(mainModels(models, 'g'))).toEqual(['a', 'b', 'c', 'd', 'e', 'g']);
        expect(ids(moreModels(models, 'g'))).toEqual(['f']);
        expect(ids(mainModels(models, 'c'))).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(ids(moreModels(models, 'c'))).toEqual(['f', 'g']);

        const featured: AgentModel[] = [{ id: 'a', name: 'A', featured: true }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];

        expect(ids(mainModels(featured, 'c'))).toEqual(['a', 'c']);
        expect(ids(moreModels(featured, 'c'))).toEqual(['b']);
    });

    it('ignore a model in force the agent does not list, and one that was never picked', () => {
        const models = named('a', 'b', 'c', 'd', 'e', 'f');

        expect(ids(mainModels(models, 'gone'))).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(ids(moreModels(models, 'gone'))).toEqual(['f']);
        expect(ids(mainModels(models, undefined))).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('split what pickableModels gives: Claude\'s default row is Opus, once, and a featured one', () => {
        const rows = pickableModels([
            { id: 'default', name: 'Default (recommended)', isDefault: true, resolvedId: 'claude-opus-5-5', featured: true },
            { id: 'opus', name: 'Opus 5.5', resolvedId: 'claude-opus-5-5', featured: true },
            { id: 'sonnet', name: 'Sonnet 5.5', resolvedId: 'claude-sonnet-5-5', featured: true },
            { id: 'claude-opus-4-6', name: 'Opus 4.6' },
        ]);

        expect(ids(mainModels(rows))).toEqual(['opus', 'sonnet']);
        expect(ids(moreModels(rows))).toEqual(['claude-opus-4-6']);
    });

    it('leave the rows they were given as they were', () => {
        const models = named('a', 'b', 'c', 'd', 'e', 'f');
        const before = structuredClone(models);

        mainModels(models, 'f');
        moreModels(models, 'f');

        expect(models).toEqual(before);
    });
});

describe('modelRow', () => {
    it('is the row of the list for an id it shows', () => {
        expect(modelRow(claude, 'sonnet')?.id).toBe('sonnet');
        expect(modelRow(claude, 'haiku-4-5')?.name).toBe('Haiku 4.5');
    });

    it('is the row of the model Claude\'s hidden default stands for', () => {
        const row = modelRow(claude, 'default');

        expect(row).toMatchObject({ id: 'opus', name: 'Opus 5.5', isDefault: true });
    });

    it('is nothing for a model the agent does not list, and for no models', () => {
        expect(modelRow(claude, 'retired')).toBeUndefined();
        expect(modelRow([], 'opus')).toBeUndefined();
    });

    it('keeps a default row that is a model of its own', () => {
        const cursor: AgentModel[] = [{ id: 'default', name: 'Auto', isDefault: true }, { id: 'gpt-5.5', name: 'GPT-5.5' }];

        expect(modelRow(cursor, 'default')?.name).toBe('Auto');
    });
});

describe('startingChoice', () => {
    it('starts on the default model and its default level when nothing is remembered', () => {
        expect(startingChoice('claude', claude, NOTHING)).toEqual({ engine: 'claude', model: 'opus', effort: 'high' });
    });

    it('starts on the model last used with the level last used on it', () => {
        const remembered: RememberedChoice = { engine: 'claude', models: { claude: 'opus' }, efforts: { 'claude/opus': 'max' } };

        expect(startingChoice('claude', claude, remembered)).toEqual({ engine: 'claude', model: 'opus', effort: 'max' });
    });

    it('falls back to the default when the remembered model is gone, and to the model\'s default when its remembered level is', () => {
        expect(startingChoice('claude', claude, { models: { claude: 'retired' }, efforts: {} })).toMatchObject({ model: 'opus', effort: 'high' });
        expect(startingChoice('claude', claude, { models: { claude: 'claude-opus-4-6' }, efforts: { 'claude/claude-opus-4-6': 'xhigh' } })).toEqual({ engine: 'claude', model: 'claude-opus-4-6', effort: 'high' });
    });

    it('gives a model with no levels none', () => {
        expect(startingChoice('claude', claude, { models: { claude: 'haiku-4-5' }, efforts: { 'claude/haiku-4-5': 'high' } })).toEqual({ engine: 'claude', model: 'haiku-4-5' });
    });

    it('does not mistake what every object inherits for a remembered model', () => {
        for (const engine of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
            expect(startingChoice(engine, [], NOTHING)).toEqual({ engine });
            expect(startingChoice(engine, claude, NOTHING)).toEqual({ engine, model: 'opus', effort: 'high' });
        }
    });

    it('returns the memory as it is while there is no list to choose from', () => {
        expect(startingChoice('codex', [], { models: { codex: 'gpt-6-sol' }, efforts: { 'codex/gpt-6-sol': 'high' } })).toEqual({ engine: 'codex', model: 'gpt-6-sol', effort: 'high' });
        expect(startingChoice('codex', [], NOTHING)).toEqual({ engine: 'codex' });
    });
});

describe('choiceForModel', () => {
    const remembered: RememberedChoice = { models: {}, efforts: { 'claude/sonnet': 'low' } };

    it('prefers the level last used on that model, then the level held now, then the model\'s own default', () => {
        const [, opus, sonnet, old] = claude;

        expect(choiceForModel('claude', sonnet, 'max', remembered).effort).toBe('low');
        expect(choiceForModel('claude', opus, 'max', remembered).effort).toBe('max');
        expect(choiceForModel('claude', old, 'xhigh', remembered).effort).toBe('high');
    });

    it('drops a level the model does not offer, and gives a model with no levels none however it was asked', () => {
        const [, opus, , , haiku] = claude;

        expect(choiceForModel('claude', opus, 'ultra', { models: {}, efforts: { 'claude/opus': 'gone' } })).toEqual({ engine: 'claude', model: 'opus', effort: 'high' });
        expect(choiceForModel('claude', haiku, 'high', { models: {}, efforts: { 'claude/haiku-4-5': 'high' } })).toEqual({ engine: 'claude', model: 'haiku-4-5' });
    });
});

describe('startingEngine', () => {
    it('is the provider last picked while it can be used, else the first that can', () => {
        expect(startingEngine(['claude', 'codex'], { ...NOTHING, engine: 'codex' })).toBe('codex');
        expect(startingEngine(['claude', 'cursor'], { ...NOTHING, engine: 'codex' })).toBe('claude');
        expect(startingEngine(['codex'], NOTHING)).toBe('codex');
        expect(startingEngine([], { ...NOTHING, engine: 'codex' })).toBeUndefined();
    });
});

describe('what is remembered', () => {
    it('is the provider, its model and the level of that model, and a model with no level leaves the levels alone', () => {
        const first = remember(NOTHING, { engine: 'claude', model: 'opus', effort: 'max' });
        const second = remember(first, { engine: 'codex', model: 'gpt-6-luna', effort: 'low' });
        const bare = remember(second, { engine: 'claude', model: 'haiku-4-5' });

        expect(second).toEqual({ engine: 'codex', models: { claude: 'opus', codex: 'gpt-6-luna' }, efforts: { 'claude/opus': 'max', 'codex/gpt-6-luna': 'low' } });
        expect(bare).toEqual({ engine: 'claude', models: { claude: 'haiku-4-5', codex: 'gpt-6-luna' }, efforts: second.efforts });
    });

    it('survives a round trip through storage', () => {
        const storage = store();
        const remembered = remember(NOTHING, { engine: 'cursor', model: 'gpt-5.5', effort: 'extra-high' });

        writeRemembered(remembered, storage);

        expect(readRemembered(storage)).toEqual(remembered);
    });

    it('does not change what it was given', () => {
        const before = remember(NOTHING, { engine: 'claude', model: 'opus', effort: 'max' });

        remember(before, { engine: 'codex', model: 'gpt-6-sol', effort: 'low' });

        expect(NOTHING).toEqual({ models: {}, efforts: {} });
        expect(before).toEqual({ engine: 'claude', models: { claude: 'opus' }, efforts: { 'claude/opus': 'max' } });
    });

    it('keeps a stored key like __proto__ as an entry of its own and never as a prototype', () => {
        const hostile = '{"engine":"claude","models":{"__proto__":"evil","claude":"opus"},"efforts":{"__proto__":{"polluted":"yes"},"constructor":"x"}}';
        const read = readRemembered(store(hostile));

        expect(Object.getPrototypeOf(read.models)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(read.efforts)).toBe(Object.prototype);
        expect(({} as Record<string, unknown>).evil).toBeUndefined();
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.keys(read.efforts)).toEqual(['constructor']);
        expect(startingChoice('claude', claude, read)).toEqual({ engine: 'claude', model: 'opus', effort: 'high' });

        const again = remember(read, { engine: 'codex', model: 'gpt-6-sol', effort: 'low' });

        expect(Object.getPrototypeOf(again.models)).toBe(Object.prototype);
        expect(again.models).toMatchObject({ claude: 'opus', codex: 'gpt-6-sol' });
    });

    it('is nothing when storage has nothing, junk, or throws', () => {
        expect(readRemembered(store())).toEqual(NOTHING);
        expect(readRemembered(store('{not json'))).toEqual(NOTHING);
        expect(readRemembered(store('[1,2]'))).toEqual(NOTHING);
        expect(readRemembered(store('null'))).toEqual(NOTHING);
        expect(readRemembered(store('"claude"'))).toEqual(NOTHING);
        expect(readRemembered({ getItem: () => {
            throw new Error('blocked');
        }, setItem: () => undefined })).toEqual(NOTHING);
        expect(readRemembered(store(JSON.stringify({ engine: 4, models: { claude: 'opus', codex: 7 }, efforts: 'x' })))).toEqual({ models: { claude: 'opus' }, efforts: {} });
        expect(() => writeRemembered(NOTHING, { getItem: () => null, setItem: () => {
            throw new Error('full');
        } })).not.toThrow();
    });
});
