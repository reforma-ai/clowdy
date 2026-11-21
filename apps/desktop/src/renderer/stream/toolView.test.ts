import { describe, expect, it } from 'vitest';

import { classifyTool, describeTool } from './toolView';

describe('describeTool', () => {
    it('reads a file by its path', () => {
        expect(describeTool('Read', { file_path: 'src/booking/form.tsx' })).toEqual({ icon: 'file', verb: 'Reading file', target: 'src/booking/form.tsx' });
        expect(describeTool('read_file', { path: 'a.ts' }).target).toBe('a.ts');
    });

    it('counts the lines of an edit as its diff stat', () => {
        const view = describeTool('Edit', { file_path: 'a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree\nfour' });

        expect(view).toMatchObject({ icon: 'code', verb: 'Editing file', target: 'a.ts', diff: { added: 4, removed: 2 } });
    });

    it('prefers the counts a tool reports in its output', () => {
        expect(describeTool('Edit', { file_path: 'a.ts' }, { added: 42, removed: 18 }).diff).toEqual({ added: 42, removed: 18 });
    });

    it('counts a written file as added lines, and gives no diff when there is nothing to count', () => {
        expect(describeTool('Write', { file_path: 'a.ts', content: 'a\nb\nc' }).diff).toEqual({ added: 3, removed: 0 });
        expect(describeTool('Edit', { file_path: 'a.ts' }, 'The file was updated.').diff).toBeUndefined();
    });

    it('shows a command as its own chip, with no verb', () => {
        expect(describeTool('Bash', { command: 'bun run typecheck' })).toEqual({ icon: 'terminal', verb: '', target: 'bun run typecheck' });
    });

    it('titles a command with what the agent says it does and keeps the command beside it', () => {
        expect(describeTool('Bash', { command: 'bun install', description: 'Install package dependencies' })).toEqual({ icon: 'terminal', verb: 'Install package dependencies', target: 'bun install' });
        expect(describeTool('shell', { cmd: 'ls', description: 'List files' })).toMatchObject({ verb: 'List files', target: 'ls' });
    });

    it('keeps one line of a description, and none when it is blank or only repeats the command', () => {
        expect(describeTool('Bash', { command: 'make', description: 'Build the app\nthen test it' }).verb).toBe('Build the app');
        expect(describeTool('Bash', { command: 'make', description: '   ' }).verb).toBe('');
        expect(describeTool('Bash', { command: 'make test', description: 'make test' }).verb).toBe('');
    });

    it('searches by pattern and finds files by glob', () => {
        expect(describeTool('Grep', { pattern: 'BookingStep', path: 'src' })).toMatchObject({ icon: 'search', verb: 'Searching', target: 'BookingStep' });
        expect(describeTool('Glob', { pattern: 'src/**/mail*' })).toMatchObject({ icon: 'search', verb: 'Finding files', target: 'src/**/mail*' });
    });

    it('names an unknown tool from its own name and shows its first short text argument', () => {
        expect(describeTool('create_task', { dependsOn: ['CAR-22'], title: 'Update the booking form' })).toEqual({ icon: 'tool', verb: 'Create task', target: 'Update the booking form' });
        expect(describeTool('spawnExecutor', 'not an object')).toEqual({ icon: 'tool', verb: 'Spawn executor', target: undefined });
    });

    it('does not show a very long argument as a chip', () => {
        expect(describeTool('note', { text: 'x'.repeat(200) }).target).toBeUndefined();
    });
});

describe('classifyTool', () => {
    it('tells reading, editing, searching, listing and commands apart, with the file or folder they work on', () => {
        expect(classifyTool('Read', { file_path: 'a.ts' })).toEqual({ activity: 'read', target: 'a.ts' });
        expect(classifyTool('Edit', { file_path: 'a.ts' })).toEqual({ activity: 'edit', target: 'a.ts' });
        expect(classifyTool('Write', { path: 'b.ts' })).toEqual({ activity: 'edit', target: 'b.ts' });
        expect(classifyTool('Delete', { path: 'c.ts' })).toEqual({ activity: 'edit', target: 'c.ts' });
        expect(classifyTool('Grep', { pattern: 'x' })).toEqual({ activity: 'search' });
        expect(classifyTool('Glob', { pattern: '*.ts' })).toEqual({ activity: 'search' });
        expect(classifyTool('WebFetch', { url: 'https://example.com' })).toEqual({ activity: 'search' });
        expect(classifyTool('Bash', { command: 'ls' })).toEqual({ activity: 'command' });
        expect(classifyTool('ls', { path: 'src' })).toEqual({ activity: 'list', target: 'src' });
    });

    it('takes a listing with no folder named for the working folder, and any other tool as other', () => {
        expect(classifyTool('list_dir', {})).toEqual({ activity: 'list', target: '.' });
        expect(classifyTool('create_task', { title: 'x' })).toEqual({ activity: 'other' });
        expect(classifyTool('Think', undefined)).toEqual({ activity: 'other' });
    });
});
