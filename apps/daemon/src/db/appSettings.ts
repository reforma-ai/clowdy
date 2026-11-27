import { branchPrefixOf, branchPrefixProblem } from '@clowdy/protocol';

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
