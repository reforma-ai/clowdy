import { capitalize, plural } from '@clowdy/lib';
import { STOPPED_TOOL } from '@clowdy/protocol';

import { classifyTool } from './toolView';

import type { StreamItemBody } from '@clowdy/protocol';

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

/** What a summary says one verb of: `ran 18 commands`, `explored 3 files, 2 searches`. */
type Clause = 'explore' | 'run' | 'edit' | 'other';

interface Tally {
    files: Set<string>;
    folders: Set<string>;
    searches: number;
    /** Every call of the clause: the commands run, the tools used. */
    calls: number;
}

const CLAUSE_OF = {
    read: 'explore',
    list: 'explore',
    search: 'explore',
    command: 'run',
    edit: 'edit',
    other: 'other',
} as const;

/** A call that names no file counts for itself: reading two unnamed files is two files. */
const unique = (call: ToolBody, target?: string) => target ?? call.toolCallId;

/**
 * Summarizes finished calls by activity, in the order those activities first appear:
 * `Ran 18 commands, explored 3 files, 2 searches`. Counts distinct files and folders, with failures at the end.
 */
export function summarizeTools(calls: readonly ToolBody[]): string {
    const tallies = new Map<Clause, Tally>();
    let failed = 0;

    for (const call of calls) {
        if (call.state === 'running') continue;

        const { activity, target } = classifyTool(call.name, call.input);
        const clause = CLAUSE_OF[activity];
        const tally = tallies.get(clause) ?? {
            files: new Set<string>(),
            folders: new Set<string>(),
            searches: 0,
            calls: 0,
        };

        tallies.set(clause, tally);
        tally.calls++;

        if (activity === 'read' || activity === 'edit') tally.files.add(unique(call, target));
        else if (activity === 'list') tally.folders.add(unique(call, target));
        else if (activity === 'search') tally.searches++;

        if (call.state === 'error' && call.error !== STOPPED_TOOL) failed++;
    }

    const clauses = [...tallies].map(([clause, tally]) => {
        switch (clause) {
            case 'run':
                return `ran ${plural(tally.calls, 'command', 'commands')}`;
            case 'edit':
                return `edited ${plural(tally.files.size, 'file', 'files')}`;
            case 'explore': {
                const parts = [
                    tally.files.size > 0 && plural(tally.files.size, 'file', 'files'),
                    tally.folders.size > 0 && plural(tally.folders.size, 'folder', 'folders'),
                    tally.searches > 0 && plural(tally.searches, 'search', 'searches'),
                ];

                return `explored ${parts.filter(Boolean).join(', ')}`;
            }
            case 'other':
                return `used ${plural(tally.calls, 'tool', 'tools')}`;
        }
    });

    if (failed > 0) clauses.push(`${failed} failed`);

    return clauses.length ? capitalize(clauses.join(', ')) : 'Tools';
}
