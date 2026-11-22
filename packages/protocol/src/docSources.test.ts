import { describe, expect, it } from 'vitest';

import { DOC_SOURCES, docSourcesOf, isDocumentPath, isMarkdownFile } from './docSources';

/** A folder that has exactly these folders (and so every folder above them). */
const has = (...folders: string[]) => {
    const all = new Set(folders.flatMap(folder => folder.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))));

    return (path: string) => all.has(path);
};

const ids = (...folders: string[]) => docSourcesOf(has(...folders)).map(source => source.id);

describe('the document sources of a folder', () => {
    it('are none for a folder that has none of the roots', () => {
        expect(ids()).toEqual([]);
        expect(ids('src', 'docs', 'plans')).toEqual([]);
    });

    it('are found by their root, each tool by its own folders', () => {
        expect(ids('.briefback')).toEqual(['briefback']);
        expect(ids('.clowdy/docs')).toEqual(['documents']);
        expect(ids('openspec/specs', 'openspec/changes/archive')).toEqual(['openspec-specs', 'openspec-changes']);
        expect(ids('.kiro/steering')).toEqual(['kiro-steering']);
        expect(ids('.kiro/specs', '.kiro/hooks')).toEqual(['kiro-specs']);
    });

    it('count Spec Kit\'s specs only beside .specify: a bare specs folder is anybody\'s', () => {
        expect(ids('specs')).toEqual([]);
        expect(ids('specs', '.specify')).toEqual(['speckit']);
        expect(ids('.specify/memory', '.specify/templates', '.specify/scripts')).toEqual(['speckit-memory']);
        expect(ids('.specify/bugs', '.specify/assessments', 'specs')).toEqual(['speckit', 'speckit-bugs', 'speckit-assessments']);
    });

    it('do not count a tool\'s own folder as a source, and not a root that is not there', () => {
        expect(ids('.specify')).toEqual([]);
        expect(ids('.kiro')).toEqual([]);
        expect(ids('openspec')).toEqual([]);
        expect(ids('.kiro/hooks', '.kiro/settings')).toEqual([]);
    });

    it('come in the registry\'s order, whatever order the folder has them in', () => {
        const all = DOC_SOURCES.map(source => source.root);

        expect(docSourcesOf(has(...[...all, '.specify'].toReversed())).map(source => source.id)).toEqual(DOC_SOURCES.map(source => source.id));
        expect(ids('.kiro/specs', '.clowdy/docs', '.briefback')).toEqual(['briefback', 'documents', 'kiro-specs']);
    });

    it('have an id and a root of their own, and a label that is not another\'s', () => {
        expect(new Set(DOC_SOURCES.map(source => source.id)).size).toBe(DOC_SOURCES.length);
        expect(new Set(DOC_SOURCES.map(source => source.root)).size).toBe(DOC_SOURCES.length);
        expect(new Set(DOC_SOURCES.map(source => source.label)).size).toBe(DOC_SOURCES.length);
    });
});

describe('a document path', () => {
    it('is a Markdown file below the root of a source, of any tool', () => {
        for (const path of ['.briefback/docs-sources/plan.md', '.clowdy/docs/decisions/pricing.md', 'specs/001-chat/spec.md', '.specify/memory/constitution.md', 'openspec/changes/add-x/proposal.md', '.kiro/steering/product.MD', '.briefback/x/notes.markdown']) {
            expect(isDocumentPath(path), path).toBe(true);
        }
    });

    it('is not a file that is not Markdown, a file outside the roots, the root itself, or a folder that only starts like one', () => {
        for (const path of ['.briefback/config.json', '.briefback/x/probe.ts.txt', 'README.md', 'docs/guide.md', '.briefback', '.briefback.md', '.briefbackup/plan.md', '.clowdy/index.md', '.specify/templates/spec-template.md', 'openspec/config.yaml', 'openspec/project.md', '.kiro/hooks/x.md']) {
            expect(isDocumentPath(path), path).toBe(false);
        }
    });
});

describe('markdown files', () => {
    it('are the ones that end in .md or .markdown, in any case', () => {
        expect(['a.md', 'A.MD', 'b.markdown', 'c.Markdown', 'dir/d.md'].every(isMarkdownFile)).toBe(true);
        expect(['a.txt', 'md', 'a.md.png', 'a.mdx', 'a.md.bak'].some(isMarkdownFile)).toBe(false);
    });
});
