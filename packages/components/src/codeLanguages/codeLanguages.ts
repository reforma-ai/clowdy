import { tagHighlighter, tags } from '@lezer/highlight';

import styles from './codeLanguages.module.css';

import type { LanguageSupport } from '@codemirror/language';

type LanguageId = 'javascript' | 'jsx' | 'typescript' | 'tsx' | 'css' | 'html' | 'json' | 'markdown';

/** File extensions and code fence names, lowercase. A map, so names like `constructor` find nothing. */
const languageByName = new Map<string, LanguageId>([
    ['js', 'javascript'],
    ['javascript', 'javascript'],
    ['mjs', 'javascript'],
    ['cjs', 'javascript'],
    ['jsx', 'jsx'],
    ['ts', 'typescript'],
    ['typescript', 'typescript'],
    ['mts', 'typescript'],
    ['cts', 'typescript'],
    ['tsx', 'tsx'],
    ['css', 'css'],
    ['html', 'html'],
    ['htm', 'html'],
    ['svg', 'html'],
    ['xml', 'html'],
    ['json', 'json'],
    ['jsonc', 'json'],
    ['md', 'markdown'],
    ['markdown', 'markdown'],
]);

// Each pack is its own chunk, loaded once for every editor.
const loaders: Record<LanguageId, () => Promise<LanguageSupport>> = {
    javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
    jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
    typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
    tsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
    css: async () => (await import('@codemirror/lang-css')).css(),
    html: async () => (await import('@codemirror/lang-html')).html(),
    json: async () => (await import('@codemirror/lang-json')).json(),
    markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
};

const loaded = new Map<LanguageId, LanguageSupport>();
const loading = new Map<LanguageId, Promise<LanguageSupport | null>>();

/**
 * CodeMirror support for a file extension or code fence name, in any case: the support once it is
 * loaded, a promise on first use, or `null` for plain text. The promise resolves `null` when the
 * load fails; the next call tries again.
 */
export function codeLanguage(name: string): LanguageSupport | Promise<LanguageSupport | null> | null {
    const id = languageByName.get(name.toLowerCase());

    if (!id) {
        return null;
    }

    const ready = loaded.get(id);

    if (ready) {
        return ready;
    }

    let pending = loading.get(id);

    if (!pending) {
        pending = loaders[id]().then(
            support => {
                loaded.set(id, support);

                return support;
            },
            () => {
                loading.delete(id);

                return null;
            }
        );
        loading.set(id, pending);
    }

    return pending;
}

/** Syntax colors on Clowdy's semantic text tokens, for the Code view and rich text code blocks. */
export const codeHighlighter = tagHighlighter([
    {
        tag: [
            tags.keyword,
            tags.modifier,
            tags.controlKeyword,
            tags.operatorKeyword,
            tags.definitionKeyword,
            tags.moduleKeyword,
        ],
        class: styles.keyword,
    },
    { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], class: styles.string },
    { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], class: styles.number },
    { tag: [tags.comment, tags.meta], class: styles.comment },
    {
        tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.propertyName, tags.macroName],
        class: styles.function,
    },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.self, tags.attributeName], class: styles.type },
    { tag: [tags.tagName, tags.invalid], class: styles.tag },
    { tag: tags.heading, class: styles.heading },
    { tag: tags.emphasis, class: styles.emphasis },
    { tag: tags.strong, class: styles.strong },
    { tag: tags.strikethrough, class: styles.strikethrough },
    { tag: [tags.link, tags.url], class: styles.link },
]);
