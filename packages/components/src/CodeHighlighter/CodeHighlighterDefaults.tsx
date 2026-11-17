import { createContext, use, type ReactNode } from 'react';

import type { ShikiHighlighterProps } from 'react-shiki';

/**
 * Optional defaults for every {@link CodeHighlighter} under {@link CodeHighlighterDefaultsProvider}.
 * Explicit props on {@link CodeHighlighter} always win.
 */
export type CodeHighlighterDefaults = {
    theme?: ShikiHighlighterProps['theme'] | 'dark' | 'light';
    showLanguage?: boolean;
    /** Strip shared leading indent from multi-line `code` before highlight (narrow panels, excerpts). */
    dedent?: boolean;
    preloadLanguages?: ShikiHighlighterProps['preloadLanguages'];
};

export const CodeHighlighterDefaultsContext = createContext<CodeHighlighterDefaults | null>(null);

/** Resolved defaults from the nearest {@link CodeHighlighterDefaultsProvider}, or `null`. */
export function useCodeHighlighterDefaults(): CodeHighlighterDefaults | null {
    return use(CodeHighlighterDefaultsContext);
}

export function CodeHighlighterDefaultsProvider({
    value,
    children,
}: {
    value: CodeHighlighterDefaults;
    children: ReactNode;
}) {
    return (
        <CodeHighlighterDefaultsContext value={ value }>
            { children }
        </CodeHighlighterDefaultsContext>
    );
}

CodeHighlighterDefaultsProvider.displayName = 'CodeHighlighterDefaultsProvider';
