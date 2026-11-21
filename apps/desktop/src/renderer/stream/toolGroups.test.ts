import { STOPPED_TOOL } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import { summarizeTools } from './toolGroups';

import type { StreamItemBody } from '@clowdy/protocol';

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

let id = 0;
const call = (name: string, input: unknown = {}, rest: Partial<ToolBody> = {}): ToolBody => ({ kind: 'tool', toolCallId: `t-${ ++id }`, name, input, state: 'done', ...rest });
const run = (command = 'ls') => call('Bash', { command });
const read = (path: string) => call('Read', { file_path: path });

describe('summarizeTools', () => {
    it('counts the commands a run ran', () => {
        expect(summarizeTools([run('pwd')])).toBe('Ran 1 command');
        expect(summarizeTools(Array.from({ length: 18 }, () => run()))).toBe('Ran 18 commands');
    });

    it('counts the distinct files read, and the searches and folders, as exploring', () => {
        expect(summarizeTools([read('a.ts'), read('b.ts'), read('a.ts'), call('Grep', { pattern: 'x' }), call('Glob', { pattern: '*' }), call('ls', { path: 'src' }), call('ls', { path: 'src' })])).toBe('Explored 2 files, 1 folder, 2 searches');
    });

    it('counts a read with no path for itself', () => {
        expect(summarizeTools([call('Read'), call('Read')])).toBe('Explored 2 files');
    });

    it('takes every listing with no folder named for the working folder', () => {
        expect(summarizeTools([call('ls'), call('list_dir', {}), call('ls', { path: '.' })])).toBe('Explored 1 folder');
    });

    it('keeps the files read and the files edited apart, since each is its own clause', () => {
        expect(summarizeTools([read('a.ts'), call('Edit', { file_path: 'a.ts' })])).toBe('Explored 1 file, edited 1 file');
    });

    it('counts the distinct files edited, whether edited, written or deleted', () => {
        expect(summarizeTools([call('Edit', { file_path: 'a.ts' }), call('Edit', { file_path: 'a.ts' }), call('Write', { file_path: 'b.ts' }), call('Delete', { path: 'c.ts' })])).toBe('Edited 3 files');
    });

    it('names a kind of work once, in the order the calls first did it', () => {
        expect(summarizeTools([run(), read('a.ts'), run(), call('Edit', { file_path: 'a.ts' }), read('b.ts')])).toBe('Ran 2 commands, explored 2 files, edited 1 file');
        expect(summarizeTools([read('a.ts'), run(), call('Grep', { pattern: 'x' })])).toBe('Explored 1 file, 1 search, ran 1 command');
    });

    it('says the other tools it cannot tell apart as used', () => {
        expect(summarizeTools([call('create_task'), call('task_list'), run()])).toBe('Used 2 tools, ran 1 command');
    });

    it('puts a verb in the present tense while a call of its kind is going, and not the others', () => {
        expect(summarizeTools([run(), run(), call('Bash', { command: 'bun test' }, { state: 'running' }), read('a.ts')])).toBe('Running 3 commands, explored 1 file');
        expect(summarizeTools([read('a.ts'), call('Read', { file_path: 'b.ts' }, { state: 'running' }), run()])).toBe('Exploring 2 files, ran 1 command');
    });

    it('puts editing and the other tools in the present tense too', () => {
        expect(summarizeTools([call('Edit', { file_path: 'a.ts' }, { state: 'running' }), call('create_task', {}, { state: 'running' }), run()])).toBe('Editing 1 file, using 1 tool, ran 1 command');
    });

    it('counts what failed at the end, and not what the person stopped', () => {
        expect(summarizeTools([run(), call('Bash', { command: 'false' }, { state: 'error', error: 'exit 1' }), call('Bash', { command: 'sleep 9' }, { state: 'error', error: STOPPED_TOOL })])).toBe('Ran 3 commands, 1 failed');
    });

    it('counts a failure of any kind of tool, with a reason or without', () => {
        expect(summarizeTools([call('Read', { file_path: 'a.ts' }, { state: 'error', error: 'missing' }), call('create_task', {}, { state: 'error' }), run()])).toBe('Explored 1 file, used 1 tool, ran 1 command, 2 failed');
    });

    it('does not call a stopped call failed, even when every call was stopped', () => {
        expect(summarizeTools([call('Bash', { command: 'a' }, { state: 'error', error: STOPPED_TOOL }), call('Bash', { command: 'b' }, { state: 'error', error: STOPPED_TOOL })])).toBe('Ran 2 commands');
    });
});
