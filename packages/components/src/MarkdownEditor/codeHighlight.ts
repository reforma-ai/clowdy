import { Extension } from '@tiptap/core';
import { createHighlightPlugin, type Parser } from 'prosemirror-highlight';
import { createParser } from 'prosemirror-highlight/lezer';

import { codeHighlighter, codeLanguage } from '../codeLanguages';

/** Fence names whose language failed to load. Each settled load highlights again, so they are not retried. */
const failed = new Set<string>();

const parser: Parser = options => {
    const name = options.language;

    if (!name || failed.has(name)) {
        return [];
    }

    const support = codeLanguage(name);

    if (support instanceof Promise) {
        return support.then(loaded => {
            if (!loaded) {
                failed.add(name);
            }
        });
    }

    return support
        ? createParser({
              parse: ({ content }) => support.language.parser.parse(content),
              highlighter: codeHighlighter,
          })(options)
        : [];
};

/** Syntax colors in fenced code blocks, with the Code view's languages and colors. */
export const CodeHighlight = Extension.create({
    name: 'codeHighlight',
    addProseMirrorPlugins() {
        return [createHighlightPlugin({ parser })];
    },
});
