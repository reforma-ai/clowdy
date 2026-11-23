import { FileManager } from '@clowdy/file-manager';
import { MemoryFileSystem } from '@clowdy/file-manager/memory';
import { reaction } from 'mobx';
import { afterEach, describe, expect, it } from 'vitest';

import { DOCS_ROOT, docsScopeOf, isDocumentPath } from './docsScope';

const managers: FileManager[] = [];

async function managerOf(files: Record<string, string>) {
    const manager = new FileManager({ provider: new MemoryFileSystem(files), hidden: ['**/.*'] });

    managers.push(manager);
    await manager.start();

    return manager;
}

afterEach(() => {
    for (const manager of managers.splice(0)) manager.dispose();
});

describe('what the Docs tab draws', () => {
    it("is the sources the folder has, each under a label of its own, in the registry's order, and says so to a screen reader", async () => {
        const manager = await managerOf({
            'src/a.ts': '',
            '.clowdy/docs/a.md': '',
            '.briefback/acp/plan.md': '',
            '.specify/memory/constitution.md': '',
            'specs/001-chat/spec.md': '',
            'openspec/changes/add-dark-mode/proposal.md': '',
            '.kiro/steering/product.md': '',
        });
        const scope = docsScopeOf(manager);

        expect(scope.roots).toEqual([
            { id: 'briefback', label: 'Briefback', root: '.briefback' },
            { id: 'documents', label: 'Documents', root: DOCS_ROOT },
            { id: 'speckit', label: 'Spec Kit', root: 'specs' },
            { id: 'speckit-memory', label: 'Spec Kit memory', root: '.specify/memory' },
            { id: 'openspec-changes', label: 'OpenSpec changes', root: 'openspec/changes' },
            { id: 'kiro-steering', label: 'Kiro steering', root: '.kiro/steering' },
        ]);
        expect(scope.label).toBe('Documents');
        expect(docsScopeOf(manager)).toBe(scope);
    });

    it("has .clowdy/docs for its only root where the folder has no source, so that the first document can be made, and takes a bare specs folder for nobody's", async () => {
        const manager = await managerOf({ 'src/a.ts': '', 'specs/readme.md': '', 'docs/guide.md': '' });

        expect(docsScopeOf(manager).roots).toEqual([{ id: 'documents', label: 'Documents', root: DOCS_ROOT }]);
    });

    it('gains a source that appears later, as an agent makes one, and the list is observable', async () => {
        const manager = await managerOf({ 'src/a.ts': '' });
        const scope = docsScopeOf(manager);
        const seen: string[][] = [];
        const stop = reaction(
            () => scope.roots.map(({ id }) => id),
            ids => seen.push(ids),
            { equals: (a, b) => a.join() === b.join() }
        );

        manager.tree.applyChanges([{ type: 'created', path: '.briefback', kind: 'directory' }]);
        manager.tree.applyChanges([{ type: 'created', path: '.briefback/acp', kind: 'directory' }]);
        manager.tree.applyChanges([{ type: 'created', path: '.specify', kind: 'directory' }]);
        manager.tree.applyChanges([{ type: 'created', path: 'specs', kind: 'directory' }]);
        stop();

        // The root a folder with no source has is replaced by the first one that comes.
        expect(seen).toEqual([['briefback'], ['briefback', 'speckit']]);
    });

    it('takes the folders and the Markdown files, and nothing else', async () => {
        const { include } = docsScopeOf(await managerOf({}));

        expect(include?.('.briefback/acp', 'directory')).toBe(true);
        expect(include?.('.briefback/acp/plan.md', 'file')).toBe(true);
        expect(include?.('.briefback/acp/a.MARKDOWN', 'file')).toBe(true);
        expect(include?.('.briefback/config.json', 'file')).toBe(false);
        expect(include?.('.briefback/acp/notes.mdx', 'file')).toBe(false);
    });

    it('gives a new file .md unless the name already has a Markdown extension', async () => {
        const { fileName } = docsScopeOf(await managerOf({}));

        expect(fileName?.('idea')).toBe('idea.md');
        expect(fileName?.('idea.md')).toBe('idea.md');
        expect(fileName?.('Plan.Markdown')).toBe('Plan.Markdown');
        expect(fileName?.('data.json')).toBe('data.json.md');
    });

    it('knows a document by its path: Markdown below the root of a source', () => {
        expect(isDocumentPath('.clowdy/docs/decisions/pricing.md')).toBe(true);
        expect(isDocumentPath('.briefback/acp/plan.md')).toBe(true);
        expect(isDocumentPath('openspec/changes/add-dark-mode/proposal.md')).toBe(true);
        expect(isDocumentPath('.briefback/config.json')).toBe(false);
        expect(isDocumentPath('docs/pricing.md')).toBe(false);
        expect(isDocumentPath('.clowdy/docsfoo/a.md')).toBe(false);
        expect(isDocumentPath('README.md')).toBe(false);
    });
});
