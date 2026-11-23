import { describe, expect, it, vi } from 'vitest';

import { FileManager } from '../src/FileManager';
import { MemoryFileSystem } from '../src/memory/MemoryFileSystem';

import type { TextDocument } from '../src/documents/TextDocument';
import type { FileManagerOptions } from '../src/FileManager';
import type { MemoryFileSystemOptions } from '../src/memory/MemoryFileSystem';

const flush = () => new Promise(resolve => setTimeout(resolve));

async function setup(
    files: Record<string, string | Uint8Array>,
    options: Omit<FileManagerOptions, 'provider'> & MemoryFileSystemOptions = {}
) {
    const fs = new MemoryFileSystem(files, options);
    const notify = vi.fn();
    const manager = new FileManager({ provider: fs, notify, ...options });

    await manager.start();

    return { fs, manager, notify };
}

async function open(manager: FileManager, path: string): Promise<TextDocument> {
    const document = await manager.open(path);

    if (!document) {
        throw new Error(`${path} did not open`);
    }

    return document;
}

function type(document: TextDocument, text: string): void {
    document.dispatch({ changes: { from: document.state!.doc.length, insert: text } });
}

function textOf(document: TextDocument): string {
    return document.state!.doc.toString();
}

async function disk(fs: MemoryFileSystem, path: string): Promise<string | null> {
    const content = await fs.read(path);

    return content.kind === 'text' ? content.text : null;
}

describe('TextDocument', () => {
    it('should load text, binary, too large and missing files by status', async () => {
        const { manager } = await setup({
            'page.tsx': 'export {};\n',
            'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            'huge.txt': 'x'.repeat(5 * 1024 * 1024 + 1),
            'hero.mp4': new Uint8Array(6 * 1024 * 1024).fill(0xff),
            'manual.pdf': new Uint8Array(6 * 1024 * 1024).fill(0xff),
        });

        const text = await open(manager, 'page.tsx');
        const binary = await open(manager, 'logo.png');
        const huge = await open(manager, 'huge.txt');
        const missing = await open(manager, 'missing.ts');
        const video = await open(manager, 'hero.mp4');
        const pdf = await open(manager, 'manual.pdf');

        expect(text.status).toBe('text');
        expect(textOf(text)).toBe('export {};\n');
        expect(binary.status).toBe('binary');
        expect(binary.blob?.size).toBe(4);
        expect(huge.status).toBe('tooLarge');
        expect(huge.state).toBeNull();
        expect(video.status).toBe('binary');
        expect(pdf.status).toBe('binary');
        expect(missing.status).toBe('error');
        expect(missing.error).toBeTruthy();
    });

    it('should be dirty only while the buffer differs from the file', async () => {
        const { manager } = await setup({ 'a.ts': 'one\n' });
        const document = await open(manager, 'a.ts');

        expect(document.dirty).toBe(false);
        type(document, 'two');
        expect(document.dirty).toBe(true);
        document.dispatch({ changes: { from: 4, to: 7 } });
        expect(document.dirty).toBe(false);
    });

    it('should run save participants, add a final newline and write the result', async () => {
        const participant = vi.fn((_path: string, text: string) => text.toUpperCase());
        const { fs, manager } = await setup({ 'a.ts': 'one\n' }, { saveParticipants: [participant] });
        const document = await open(manager, 'a.ts');

        type(document, 'two');

        expect(await document.save()).toBe(true);
        expect(participant).toHaveBeenCalledWith('a.ts', 'one\ntwo');
        expect(await disk(fs, 'a.ts')).toBe('ONE\nTWO\n');
        expect(textOf(document)).toBe('ONE\nTWO\n');
        expect(document.dirty).toBe(false);
    });

    it('should keep what the person types while save participants run', async () => {
        let release: () => void = () => {};
        const participant = async (_path: string, text: string) => {
            await new Promise<void>(resolve => {
                release = resolve;
            });

            return text.toUpperCase();
        };
        const { fs, manager } = await setup({ 'a.ts': 'one\n' }, { saveParticipants: [participant] });
        const document = await open(manager, 'a.ts');

        type(document, 'two');
        const saving = document.save();

        await flush();
        type(document, '!');
        release();

        expect(await saving).toBe(true);
        await flush();

        expect(await disk(fs, 'a.ts')).toBe('ONE\nTWO\n');
        expect(textOf(document)).toBe('one\ntwo!');
        expect(document.dirty).toBe(true);
        expect(document.conflict).toBe(false);
    });

    it("should keep the file's CRLF line breaks", async () => {
        const { fs, manager } = await setup({ 'win.txt': 'a\r\nb\r\n' });
        const document = await open(manager, 'win.txt');

        type(document, 'c');
        await document.save();

        expect(await disk(fs, 'win.txt')).toBe('a\r\nb\r\nc\r\n');
    });

    it('should skip the watch echo of its own save', async () => {
        const { manager } = await setup({ 'a.ts': 'one\n' });
        const document = await open(manager, 'a.ts');

        type(document, 'two');
        await document.save();
        type(document, 'three');
        await flush();

        expect(document.conflict).toBe(false);
        expect(textOf(document)).toBe('one\ntwo\nthree');
    });

    it('should skip its own echo when changes carry no version', async () => {
        const { manager } = await setup({ 'a.ts': 'one\n' }, { omitEventVersions: true });
        const document = await open(manager, 'a.ts');

        type(document, 'two');
        await document.save();
        type(document, 'three');
        await flush();

        expect(document.conflict).toBe(false);
        expect(textOf(document)).toBe('one\ntwo\nthree');
    });

    it('should reload a clean buffer in place when the file changes on disk', async () => {
        const { fs, manager } = await setup({ 'a.ts': 'one\ntwo\n' });
        const document = await open(manager, 'a.ts');

        document.select({ from: { line: 2, column: 2 } });
        await fs.write('a.ts', 'zero\none\ntwo\n');
        await flush();

        expect(textOf(document)).toBe('zero\none\ntwo\n');
        expect(document.dirty).toBe(false);
        expect(document.selection).toEqual({ from: { line: 3, column: 2 } });
    });

    it('should reload a clean buffer when the change carries no version', async () => {
        const { fs, manager } = await setup({ 'a.ts': 'one\n' }, { omitEventVersions: true });
        const document = await open(manager, 'a.ts');

        await fs.write('a.ts', 'two\n');
        await flush();

        expect(textOf(document)).toBe('two\n');
    });

    it('should mark a dirty buffer changed on disk and keep the edits', async () => {
        const { fs, manager } = await setup({ 'a.ts': 'one\n' });
        const document = await open(manager, 'a.ts');

        type(document, 'mine');
        await fs.write('a.ts', 'theirs\n');
        await flush();

        expect(document.conflict).toBe(true);
        expect(textOf(document)).toBe('one\nmine');
    });

    it('should not write over a newer version on save', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'one\n' });
        // Not started, so nothing watches: only the save can find the newer version.
        const manager = new FileManager({ provider: fs });
        const document = await open(manager, 'a.ts');

        await fs.write('a.ts', 'theirs\n');
        type(document, 'mine');

        expect(await document.save()).toBe(false);
        expect(document.conflict).toBe(true);
        expect(await disk(fs, 'a.ts')).toBe('theirs\n');
    });

    it('should overwrite the newer version, or reload it', async () => {
        const { fs, manager } = await setup({ 'a.ts': 'one\n', 'b.ts': 'one\n' });
        const kept = await open(manager, 'a.ts');
        const discarded = await open(manager, 'b.ts');

        type(kept, 'mine');
        type(discarded, 'mine');
        await fs.write('a.ts', 'theirs\n');
        await fs.write('b.ts', 'theirs\n');
        await flush();

        expect(await kept.overwrite()).toBe(true);
        await discarded.reload();

        expect(await disk(fs, 'a.ts')).toBe('one\nmine\n');
        expect(kept.conflict).toBe(false);
        expect(textOf(discarded)).toBe('theirs\n');
        expect(discarded.conflict).toBe(false);
        expect(discarded.dirty).toBe(false);
    });

    it('should recreate a file that is gone when the person overwrites', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'one\n' });
        // Not started, so only the save finds the file gone.
        const manager = new FileManager({ provider: fs });
        const document = await open(manager, 'a.ts');

        await fs.delete(['a.ts']);
        type(document, 'mine');

        expect(await document.save()).toBe(false);
        expect(document.conflict).toBe(true);
        expect(await document.overwrite()).toBe(true);
        expect(await disk(fs, 'a.ts')).toBe('one\nmine\n');
    });

    it('should reload a clean tab whose file is replaced in one batch', async () => {
        const { fs, manager } = await setup({ 'a.ts': 'old\n', 'b.ts': 'new\n' });
        const document = await open(manager, 'a.ts');

        await fs.move([{ from: 'b.ts', to: 'a.ts' }], { overwrite: true });
        await flush();

        expect(manager.tabs.get('a.ts')).toBe(document);
        expect(textOf(document)).toBe('new\n');
    });

    it('should close a clean tab when its file is deleted', async () => {
        const { fs, manager } = await setup({ 'src/a.ts': 'a\n', 'b.ts': 'b\n' });

        await open(manager, 'src/a.ts');
        await open(manager, 'b.ts');
        await fs.delete(['src']);
        await flush();

        expect(manager.tabs.documents.map(document => document.path)).toEqual(['b.ts']);
    });

    it('should show markdown as rich text, SVG as a preview and other files as source, following renames', async () => {
        const { manager } = await setup({
            'README.md': '# Hi\n',
            'notes.markdown': '',
            'page.mdx': '',
            'a.ts': '',
            'logo.svg': '<svg/>\n',
        });
        const readme = await open(manager, 'README.md');
        const logo = await open(manager, 'logo.svg');

        expect(readme.view).toBe('rich');
        expect((await open(manager, 'notes.markdown')).view).toBe('rich');
        expect((await open(manager, 'page.mdx')).view).toBe('source');
        expect((await open(manager, 'a.ts')).view).toBe('source');
        expect(logo.view).toBe('preview');

        logo.setView('source');
        expect(logo.view).toBe('source');

        logo.setView('preview');
        expect(logo.view).toBe('preview');

        await manager.operations.rename('README.md', 'README.txt');
        expect(readme.view).toBe('source');

        await manager.operations.rename('README.txt', 'README.md');
        expect(readme.view).toBe('rich');
    });

    it('should apply replaced text as one minimal change that keeps the cursor and marks the buffer dirty', async () => {
        const { fs, manager } = await setup({ 'a.md': 'one\ntwo\n' });
        const document = await open(manager, 'a.md');

        document.dispatch({ selection: { anchor: 2 } });
        document.replaceText('one\ntwo!\n');

        expect(textOf(document)).toBe('one\ntwo!\n');
        expect(document.state!.selection.main.head).toBe(2);
        expect(document.dirty).toBe(true);

        await document.save();
        expect(await disk(fs, 'a.md')).toBe('one\ntwo!\n');

        document.replaceText('one\ntwo!\n');
        expect(document.dirty).toBe(false);
    });

    it('should switch to source to show a selection, and when rich text refuses a markdown file', async () => {
        const { manager } = await setup({ 'a.md': 'one\ntwo\n' });
        const document = await open(manager, 'a.md');

        document.select({ from: { line: 2, column: 1 } });
        expect(document.view).toBe('source');

        document.setView('rich');
        document.blockRichText('Raw HTML would be lost.');
        expect(document.view).toBe('source');
        expect(document.richTextBlocked).toBe('Raw HTML would be lost.');

        await manager.operations.rename('a.md', 'a.txt');
        expect(document.richTextBlocked).toBeNull();

        await manager.operations.rename('a.txt', 'a.md');
        document.setView('rich');
        expect(document.view).toBe('rich');
        expect(document.richTextBlocked).toBeNull();
    });

    it('should keep a dirty tab marked deleted, and recreate the file on save', async () => {
        const { fs, manager } = await setup({ 'a.ts': 'a\n' });
        const document = await open(manager, 'a.ts');

        type(document, 'b');
        await fs.delete(['a.ts']);
        await flush();

        expect(manager.tabs.get('a.ts')).toBe(document);
        expect(document.deleted).toBe(true);
        expect(document.dirty).toBe(true);

        expect(await document.save()).toBe(true);
        expect(await disk(fs, 'a.ts')).toBe('a\nb\n');
        expect(document.deleted).toBe(false);
    });
});
