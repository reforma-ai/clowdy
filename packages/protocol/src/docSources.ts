/**
 * Where a project folder keeps the documents its work is written down in: the roots the Docs tab shows, each a gray label with its Markdown file tree. One registry for
 * the daemon (which lists them for the `@` mentions and the palette, from the disk) and the app (which finds them in the file tree it holds, so a root an agent creates
 * shows up through the file manager's watch), kept pure for that reason: `docSourcesOf` is told what exists and no more.
 *
 * A source is a root of the folder, never a tool's whole folder: a tool's own folder holds templates, scripts and agent files that are Markdown too.
 */
export interface DocSourceDef {
    id: string;
    /** What the Docs tab calls it: the tool's name, and what the root holds where one tool has several roots. */
    label: string;
    /** The folder, relative to the project folder, with `/` separators. */
    root: string;
    /** A folder that has to exist beside it for the root to count: `specs` is Spec Kit's only where `.specify` is (a bare `specs` is anybody's). */
    requires?: string;
}

/**
 * The sources a project folder can have, in the order the Docs tab draws them. Briefback is Clowdy's own format: its plans, research and handoffs are what the work
 * is done from. `.clowdy/docs` is kept as one more source while the format of project documents is open; the agents' skills still write there.
 */
export const DOC_SOURCES: readonly DocSourceDef[] = [
    { id: 'briefback', label: 'Briefback', root: '.briefback' },
    { id: 'documents', label: 'Documents', root: '.clowdy/docs' },
    { id: 'speckit', label: 'Spec Kit', root: 'specs', requires: '.specify' },
    { id: 'speckit-memory', label: 'Spec Kit memory', root: '.specify/memory' },
    { id: 'speckit-bugs', label: 'Spec Kit bugs', root: '.specify/bugs' },
    { id: 'speckit-assessments', label: 'Spec Kit assessments', root: '.specify/assessments' },
    { id: 'openspec-specs', label: 'OpenSpec specs', root: 'openspec/specs' },
    { id: 'openspec-changes', label: 'OpenSpec changes', root: 'openspec/changes' },
    { id: 'kiro-specs', label: 'Kiro specs', root: '.kiro/specs' },
    { id: 'kiro-steering', label: 'Kiro steering', root: '.kiro/steering' },
];

/** Whether a name is a Markdown file: a document is one. */
export const isMarkdownFile = (name: string) => /\.(?:md|markdown)$/i.test(name);

/**
 * The sources a folder has, in the registry's order: the roots that are folders, and whose required folder is there. `isDirectory` takes a path relative to the project
 * folder (`.specify`, `.briefback`) and says whether it is a folder; the caller decides what that means (a stat on the disk, an entry of the tree).
 */
export function docSourcesOf(isDirectory: (path: string) => boolean): DocSourceDef[] {
    return DOC_SOURCES.filter(source => (source.requires === undefined || isDirectory(source.requires)) && isDirectory(source.root));
}

/**
 * Whether a path of the project folder (`/`-separated) is a document: a Markdown file below the root of any source of the registry. The rule is static, so a path can be
 * sent to the Docs tab without asking what the folder has; `specs/x.md` of a folder without `.specify` is one, and the tab opens it though its tree does not draw it.
 */
export function isDocumentPath(path: string): boolean {
    return isMarkdownFile(path) && DOC_SOURCES.some(source => path.startsWith(`${ source.root }/`));
}
