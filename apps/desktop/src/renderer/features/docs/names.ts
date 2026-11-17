const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;
/** What no file name may hold on Windows or macOS. */
// eslint-disable-next-line no-control-regex -- control characters are part of what is refused
const FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;

export type NewDocumentPath = { path: string } | { error: string };

/**
 * The path for a document the person named: `/` makes folders, and `.md` is added when it is missing.
 * `taken` are the paths that exist already (any case, because macOS and Windows treat `A.md` and `a.md` as one file).
 */
export function newDocumentPath(input: string, taken: Iterable<string>): NewDocumentPath {
    const segments = input.trim().replaceAll('\\', '/').split('/').map(segment => segment.trim()).filter(segment => segment !== '' && segment !== '.');

    if (segments.length === 0) return { error: 'Enter a name for the document.' };

    if (segments.includes('..')) return { error: 'A name cannot contain "..".' };

    if (segments.some(segment => FORBIDDEN.test(segment))) return { error: 'A name cannot contain < > : " | ? * or control characters.' };

    const name = segments.pop()!;
    const path = [...segments, MARKDOWN_EXTENSION.test(name) ? name : `${ name }.md`].join('/');

    if (isTaken(path, taken)) return { error: `${ path } already exists.` };

    return { path };
}

/** The path for the copy of a file that holds the person's text: `plan.md` becomes `plan (my copy).md`, then `plan (my copy 2).md`. */
export function copyPath(path: string, taken: Iterable<string>): string {
    const extension = MARKDOWN_EXTENSION.exec(path)?.[0] ?? '';
    const stem = path.slice(0, path.length - extension.length);
    const used = new Set([...taken].map(candidate => candidate.toLowerCase()));

    for (let number = 1; ; number++) {
        const candidate = `${ stem } (my copy${ number > 1 ? ` ${ number }` : '' })${ extension }`;

        if (!used.has(candidate.toLowerCase())) return candidate;
    }
}

/** A first heading for a new document, from its file name: `booking-flow.md` gives `# Booking flow`. */
export function initialContent(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1).replace(MARKDOWN_EXTENSION, '').replace(/[-_]+/g, ' ').trim();
    const title = name.charAt(0).toUpperCase() + name.slice(1);

    return `# ${ title }\n\n`;
}

function isTaken(path: string, taken: Iterable<string>): boolean {
    const wanted = path.toLowerCase();

    for (const candidate of taken) if (candidate.toLowerCase() === wanted) return true;

    return false;
}
