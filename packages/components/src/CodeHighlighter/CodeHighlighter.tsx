import { SHIKI_THEME_DARK, SHIKI_THEME_LIGHT } from '@clowdy/constants';
import { cn, dedentText, isHtmlProp, useMediaQuery } from '@clowdy/lib';
import {
    type CSSProperties,
    type FC,
    type HTMLAttributes,
    lazy,
    type ReactNode,
    Suspense,
    useMemo,
    useState,
} from 'react';

import { Scrollable, type ScrollableProps, ScrollExpandChevronButton } from '../Scrollable';
import styles from './CodeHighlighter.module.css';
import { useCodeHighlighterDefaults } from './CodeHighlighterDefaults';

import type { ShikiHighlighterProps } from 'react-shiki';

/** POSIX-style line count */
function countCodeLines(text: string): number {
    if (text === '') {
        return 0;
    }

    const parts = text.split(/\r?\n/);
    let n = parts.length;

    if (n > 0 && parts[n - 1] === '') {
        n -= 1;
    }

    return n;
}

export type CodeHighlighterScrollableHtmlProps = Omit<
    HTMLAttributes<HTMLDivElement>,
    'className' | 'children' | 'style' | 'onScroll'
>;

export type CodeHighlighterProps = Omit<ShikiHighlighterProps, 'children' | 'theme' | 'className'> & {
    theme?: ShikiHighlighterProps['theme'] | 'dark' | 'light';
    language: string;
    code: string;
    className?: string;
    /** Passed to the inner Shiki wrapper */
    codeClassName?: string;
    containerClassName?: string;
    overlay?: ReactNode;
    onScroll?: ScrollableProps['onScroll'];
    stickToBottom?: ScrollableProps['stickToBottom'];
    /**
     * When set to **N**: if `code` has **more than N lines**, show clamp + expand control,
     * and the collapsed peek height fits **N lines** (`max-height` uses N×`lh`).
     * Expanded has no max-height.
     */
    collapseThresholdLines?: number;
    /** `aria-label` strings for the collapse control; defaults match assistant markdown / edit tool copy. */
    collapseLabels?: {
        expand: string;
        collapse: string;
    };
    /**
     * Strip shared leading space/tab indent from `code` before highlight.
     * Useful for nested repository excerpts; off by default so samples keep literal layout.
     */
    dedent?: boolean;
} & CodeHighlighterScrollableHtmlProps;

const DEFAULT_COLLAPSE_LABELS = {
    expand: 'Show full code',
    collapse: 'Show fewer lines',
} as const;

const ShikiHighlighter = lazy(async () => import('react-shiki'));

export const CodeHighlighter: FC<CodeHighlighterProps> = ({
    code,
    language,
    theme: themeProp,
    className,
    codeClassName,
    containerClassName,
    overlay,
    onScroll,
    stickToBottom,
    showLanguage: showLanguageProp,
    collapseThresholdLines,
    collapseLabels,
    dedent: dedentProp,
    preloadLanguages: preloadLanguagesProp,
    style,
    ...props
}) => {
    const defaults = useCodeHighlighterDefaults();
    const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
    const systemTheme = prefersDark ? 'dark' : 'light';
    const theme = themeProp ?? defaults?.theme ?? systemTheme;
    const showLanguage = showLanguageProp ?? defaults?.showLanguage ?? false;
    const dedent = dedentProp ?? defaults?.dedent ?? false;
    const preloadLanguages = preloadLanguagesProp ?? defaults?.preloadLanguages;

    const displayCode = useMemo(() => (dedent ? dedentText(code ?? '') : (code ?? '')), [code, dedent]);

    const resolvedTheme: ShikiHighlighterProps['theme'] =
        theme === 'dark' ? SHIKI_THEME_DARK : theme === 'light' ? SHIKI_THEME_LIGHT : theme;

    const lineCount = useMemo(() => countCodeLines(displayCode), [displayCode]);
    const collapsible = collapseThresholdLines != null && lineCount > collapseThresholdLines;
    const [collapseExpanded, setCollapseExpanded] = useState(false);

    const collapseLabelExpand = collapseLabels?.expand ?? DEFAULT_COLLAPSE_LABELS.expand;
    const collapseLabelCollapse = collapseLabels?.collapse ?? DEFAULT_COLLAPSE_LABELS.collapse;

    const scrollDomProps: Record<string, unknown> = {};
    const shikiProps: Record<string, unknown> = {};

    for (const key of Object.keys(props)) {
        const value = props[key as keyof typeof props];

        if (isHtmlProp(key)) {
            scrollDomProps[key] = value;
        } else {
            shikiProps[key] = value;
        }
    }

    let scrollRootStyle: CSSProperties | undefined = style;

    if (collapsible && collapseThresholdLines != null) {
        scrollRootStyle = {
            ...style,
            ['--codehighlighter-collapse-preview-lines' as string]: collapseThresholdLines,
        };
    }

    const collapseOverlay = collapsible ? (
        <ScrollExpandChevronButton
            expanded={collapseExpanded}
            onPress={() => setCollapseExpanded(v => !v)}
            labelExpand={collapseLabelExpand}
            labelCollapse={collapseLabelCollapse}
            className={styles.expandToggle}
        />
    ) : null;

    return (
        <Scrollable
            vertical
            horizontal
            className={cn(className, styles.root)}
            containerClass={containerClassName}
            overlay={overlay ?? collapseOverlay}
            onScroll={onScroll}
            stickToBottom={stickToBottom}
            style={scrollRootStyle}
            aria-expanded={collapsible ? collapseExpanded : undefined}
            {...scrollDomProps}
        >
            <Suspense
                fallback={
                    <pre className={cn(styles.code, codeClassName)}>
                        <code>{displayCode}</code>
                    </pre>
                }
            >
                <ShikiHighlighter
                    as="div"
                    {...shikiProps}
                    className={cn(styles.code, codeClassName, {
                        dark: theme === 'dark',
                    })}
                    language={language}
                    theme={resolvedTheme}
                    showLanguage={showLanguage}
                    preloadLanguages={preloadLanguages}
                    addDefaultStyles={false}
                >
                    {displayCode}
                </ShikiHighlighter>
            </Suspense>
        </Scrollable>
    );
};
