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
    /** A call of this clause is still going: its verb is in the present tense. */
    running: boolean;
}

const CLAUSE_OF = { read: 'explore', list: 'explore', search: 'explore', command: 'run', edit: 'edit', other: 'other' } as const;

/** A call that names no file counts for itself: reading two unnamed files is two files. */
const unique = (call: ToolBody, target?: string) => target ?? call.toolCallId;

/**
 * Says what a run of tool calls did, in one line, as the work of a phase is told: `Ran 18 commands, explored 3 files, 2 searches`. A clause names one kind of
 * work, in the order the calls first did it (reads, folders and searches are exploring; running commands, editing files and any other tool are each one
 * clause); the count of files and folders is of the distinct ones, and a verb is in the present tense while a call of its clause runs. The calls that failed
 * (not the ones stopped with the run) are counted at the end, since a closed group hides them.
 */
export function summarizeTools(calls: readonly ToolBody[]): string {
    const tallies = new Map<Clause, Tally>();
    let failed = 0;

    for (const call of calls) {
        const { activity, target } = classifyTool(call.name, call.input);
        const clause = CLAUSE_OF[activity];
        const tally = tallies.get(clause) ?? { files: new Set<string>(), folders: new Set<string>(), searches: 0, calls: 0, running: false };

        tallies.set(clause, tally);
        tally.calls++;
        tally.running ||= call.state === 'running';

        if (activity === 'read' || activity === 'edit') tally.files.add(unique(call, target));
        else if (activity === 'list') tally.folders.add(unique(call, target));
        else if (activity === 'search') tally.searches++;

        if (call.state === 'error' && call.error !== STOPPED_TOOL) failed++;
    }

    const clauses = [...tallies].map(([clause, tally]) => {
        const now = tally.running;

        switch (clause) {
            case 'run':
                return `${ now ? 'running' : 'ran' } ${ plural(tally.calls, 'command', 'commands') }`;
            case 'edit':
                return `${ now ? 'editing' : 'edited' } ${ plural(tally.files.size, 'file', 'files') }`;
            case 'explore': {
                const parts = [
                    tally.files.size > 0 && plural(tally.files.size, 'file', 'files'),
                    tally.folders.size > 0 && plural(tally.folders.size, 'folder', 'folders'),
                    tally.searches > 0 && plural(tally.searches, 'search', 'searches'),
                ];

                return `${ now ? 'exploring' : 'explored' } ${ parts.filter(Boolean).join(', ') }`;
            }
            case 'other':
                return `${ now ? 'using' : 'used' } ${ plural(tally.calls, 'tool', 'tools') }`;
        }
    });

    if (failed > 0) clauses.push(`${ failed } failed`);

    return capitalize(clauses.join(', '));
}
