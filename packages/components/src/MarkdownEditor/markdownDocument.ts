import { Extension } from '@tiptap/core';
import { Image } from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import { StarterKit } from '@tiptap/starter-kit';
import { Marked } from 'marked';

import { CodeHighlight } from './codeHighlight';

import type { Extensions } from '@tiptap/core';
import type { marked, Token, Tokens, TokensList } from 'marked';

/** Larger files open in source mode: parsing and serializing them on every keystroke lags. */
export const MARKDOWN_MAX_BYTES = 256 * 1024;

/** Loads an image's `src` as something the browser can show, such as an object URL. */
export type ResolveImageSrc = (src: string) => Promise<string>;

/** The editor's schema and markdown rules; the support check runs on the same list. */
export function markdownExtensions(resolveImageSrc?: ResolveImageSrc): Extensions {
    return [
        // Markdown has no underline; a trailing node would edit the document on its own.
        StarterKit.configure({ underline: false, trailingNode: false, link: { openOnClick: false } }),
        LinearTaskList,
        TaskItem.configure({ nested: true }),
        TableKit,
        (resolveImageSrc ? resolvedImage(resolveImageSrc) : Image).configure({ inline: true }),
        CodeHighlight,
        QuoteShortcut,
        Markdown.configure(markdownOptions()),
    ];
}

/** The key that makes a quote, and the one TipTap's Blockquote has by default that this editor gives up. */
const QUOTE_KEY = 'Mod-Shift-.';
const TIPTAP_QUOTE_KEY = 'Mod-Shift-b';

/** A Mac, where the desktop app's side panel is on `Cmd+Esc`: `Cmd+Shift+B` is the editor's. Elsewhere `Ctrl+Shift+B` is the panel's. */
const onMac = () => typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

/**
 * Quote on `Cmd+Shift+.` (`Ctrl+Shift+.`), as GitHub's editor has it, and on a Mac on TipTap's own `Cmd+Shift+B` too. Off a Mac `Ctrl+Shift+B` is the desktop app's key
 * for its side panel, so the editor gives it up there: it is taken here, before Blockquote's own binding, and does nothing, so a window that does not claim the key
 * does not make a quote either.
 */
const QuoteShortcut = Extension.create({
    name: 'quoteShortcut',
    priority: 1000,
    addKeyboardShortcuts() {
        return {
            [QUOTE_KEY]: ({ editor }) => editor.commands.toggleBlockquote(),
            ...(onMac() ? {} : { [TIPTAP_QUOTE_KEY]: () => true }),
        };
    },
});

const taskListTokenizer = TaskList.config.markdownTokenizer!;

/**
 * TaskList that tokenizes only where a task item starts. Its tokenizer splits all the remaining
 * markdown into lines at every block, which makes parsing quadratic.
 */
const LinearTaskList = TaskList.extend({
    markdownTokenizer: {
        ...taskListTokenizer,
        tokenize: (src, tokens, lexer) =>
            /^\s*[-+*]\s+\[[ xX]\]\s+/.test(src) ? taskListTokenizer.tokenize(src, tokens, lexer) : undefined,
    },
});

function markdownOptions() {
    return {
        // Its own instance: TipTap registers tokenizers on it, and streamdown lexes with the global one.
        marked: new Marked() as unknown as typeof marked,
        markedOptions: { gfm: true },
    };
}

/** Shows `src` through `resolve`; the node keeps the path written in the file. */
function resolvedImage(resolve: ResolveImageSrc) {
    return Image.extend({
        addNodeView() {
            return ({ node, HTMLAttributes }) => {
                const img = document.createElement('img');

                for (const [name, value] of Object.entries(HTMLAttributes)) {
                    if (value != null && name !== 'src') {
                        img.setAttribute(name, String(value));
                    }
                }

                const src = String(node.attrs.src ?? '');

                void resolve(src).then(
                    url => {
                        img.src = url;
                    },
                    () => {
                        img.src = src;
                    }
                );

                return { dom: img };
            };
        },
    });
}

const FRONT_MATTER = /^(?:---\n(?:[\s\S]*?\n)?---|\+\+\+\n(?:[\s\S]*?\n)?\+\+\+)[ \t]*(?:\n|$)(?:[ \t]*\n)*/;

/** Splits a leading `---` YAML or `+++` TOML block, with the blank lines after it, from the body. */
export function splitFrontMatter(markdown: string): { frontMatter: string; body: string } {
    const frontMatter = FRONT_MATTER.exec(markdown)?.[0] ?? '';

    return { frontMatter, body: markdown.slice(frontMatter.length) };
}

/**
 * The front matter `markdown` has before `body`, `''` when it has none; `null` when `markdown` is
 * not `body` after a front matter block. Unlike `splitFrontMatter`, it leaves blank lines that
 * open `body` (an empty first paragraph) in the body.
 */
export function frontMatterBefore(markdown: string, body: string): string | null {
    const frontMatter = markdown.slice(0, markdown.length - body.length);

    return markdown.endsWith(body) && (!frontMatter || FRONT_MATTER.exec(frontMatter)?.[0] === frontMatter)
        ? frontMatter
        : null;
}

/** Token types the extensions turn into document nodes without losing text. */
const SUPPORTED_TOKENS = new Set([
    'space',
    'paragraph',
    'heading',
    'text',
    'escape',
    'strong',
    'em',
    'del',
    'codespan',
    'br',
    'link',
    'image',
    'code',
    'blockquote',
    'hr',
    'list',
    'list_item',
    'checkbox',
    'table',
    'taskList',
    'taskItem',
]);

/** A footnote definition line. marked reads it as a paragraph, or as a link definition when one word follows. */
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^[^\]\s]+\]:/m;

/** An ordered list item that GFM renders with a checkbox. */
const ORDERED_TASK_ITEM = /^\s*\d+[.)]\s+\[[ xX]\]\s/;

/** A named character reference TipTap shows as written and saves escaped; it decodes numeric ones and these four. */
const NAMED_ENTITY = /&(?!(?:lt|gt|quot|amp);)[a-z][a-z\d]*;/i;

function hasUnsupportedToken(tokens: readonly Token[]): boolean {
    return tokens.some(token => {
        if (!SUPPORTED_TOKENS.has(token.type)) {
            return true;
        }

        // TipTap's lists read these as plain text, so a save would escape or flatten them.
        if (
            token.type === 'list' &&
            token.ordered &&
            token.items.some((item: Tokens.ListItem) => ORDERED_TASK_ITEM.test(item.raw))
        ) {
            return true;
        }

        if (token.type === 'list_item' && token.tokens?.[0]?.type === 'heading') {
            return true;
        }

        // Inline text only: block text tokens also hold code spans, where entities stay literal.
        if (token.type === 'text' && !token.tokens && NAMED_ENTITY.test(token.raw)) {
            return true;
        }

        return hasUnsupportedToken([
            ...('tokens' in token && Array.isArray(token.tokens) ? token.tokens : []),
            ...('items' in token && Array.isArray(token.items) ? token.items : []),
            ...(token.type === 'table'
                ? [...token.header, ...token.rows.flat()].flatMap(cell => cell.tokens as Token[])
                : []),
        ] as Token[]);
    });
}

/** `markdown` ending in a newline when `like` does; the serializer drops the file's last one. */
export function withTrailingNewline(markdown: string, like: string): string {
    return like.endsWith('\n') && markdown && !markdown.endsWith('\n') ? `${markdown}\n` : markdown;
}

let standaloneManager: MarkdownManager | undefined;

/** Parses and serializes markdown outside an editor, with the editor's extensions. */
function markdownManager(): MarkdownManager {
    return (standaloneManager ??= new MarkdownManager({ ...markdownOptions(), extensions: markdownExtensions() }));
}

/** `body` as the editor would serialize it after parsing it; `null` when it can't parse it. */
export function canonicalMarkdown(body: string): string | null {
    try {
        const manager = markdownManager();

        return manager.serialize(manager.parse(body));
    } catch {
        return null;
    }
}

/** `tooLarge` marks a file the editor does not load; it shows other unsupported files read-only. */
type MarkdownSupport = { supported: true } | { supported: false; reason: string; tooLarge?: true };

const SOURCE_ONLY: MarkdownSupport = {
    supported: false,
    reason: 'Some markdown in this file can only be edited in source mode',
};

/**
 * Whether the editor can show `body` (markdown without front matter) and save it back without
 * losing anything: every token is one the extensions handle, and its canonical form parses to
 * the same document.
 */
export function markdownSupport(body: string): MarkdownSupport {
    if (new TextEncoder().encode(body).length > MARKDOWN_MAX_BYTES) {
        return { supported: false, reason: 'The file is larger than 256 KB.', tooLarge: true };
    }

    const manager = markdownManager();
    const tokens: TokensList = manager.instance.lexer(body);

    if (FOOTNOTE_DEFINITION.test(body) || Object.keys(tokens.links).length > 0 || hasUnsupportedToken(tokens)) {
        return SOURCE_ONLY;
    }

    const doc = manager.parse(body);

    return JSON.stringify(manager.parse(manager.serialize(doc))) === JSON.stringify(doc)
        ? { supported: true }
        : SOURCE_ONLY;
}
