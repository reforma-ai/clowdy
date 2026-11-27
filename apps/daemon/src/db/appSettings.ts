import { branchPrefixOf, branchPrefixProblem, delegationSettingsSchema } from '@clowdy/protocol';

import { invalid } from '../errors';

import type { Database } from 'bun:sqlite';

export function readBranchPrefix(db: Database): string | undefined {
    return db.query<{ value: string }, []>("SELECT value FROM app_settings WHERE key = 'branchPrefix'").get()?.value;
}

export function writeBranchPrefix(db: Database, text: string): string {
    const problem = branchPrefixProblem(text);
    if (problem) throw invalid(problem);
    const prefix = branchPrefixOf(text);
    db.query(
        "INSERT INTO app_settings (key, value) VALUES ('branchPrefix', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(prefix);
    return prefix;
}

/** Global role choices; missing settings retain the historical launch behavior. */
export function readDelegation(db: Database) {
    const raw = db.query<{ value: string }, []>("SELECT value FROM app_settings WHERE key = 'delegation'").get()?.value;
    if (!raw) return {};
    try {
        return delegationSettingsSchema.parse(JSON.parse(raw));
    } catch {
        throw new Error('Delegation settings could not be read');
    }
}

export function writeDelegation(db: Database, settings: import('@clowdy/protocol').DelegationSettings) {
    const value = delegationSettingsSchema.parse(settings);
    db.query(
        "INSERT INTO app_settings (key, value) VALUES ('delegation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify(value));
    return value;
}
