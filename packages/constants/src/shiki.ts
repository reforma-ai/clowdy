/**
 * Default bundled Shiki theme ids (github) shared by CodeHighlighter, Streamdown code fences, etc.
 * Streamdown `shikiTheme` is `[light, dark]` — use these two in that order.
 */
export const SHIKI_THEME_LIGHT = 'github-light' as const;
export const SHIKI_THEME_DARK = 'github-dark' as const;

/** Grammars preloaded for {@link CodeHighlighter} (tool JSON, markdown fences, edits). */
export const CODE_HIGHLIGHTER_PRELOAD_LANGUAGES = ['json', 'html', 'typescript', 'tsx', 'css'] as const;

/** File extension (no dot) → Shiki / highlighter language id. */
export const EXTENSION_TO_SHIKI_LANGUAGE = {
    js: 'typescript',
    jsx: 'tsx',
    ts: 'typescript',
    tsx: 'tsx',
    py: 'python',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    md: 'markdown',
    sh: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
    txt: 'plaintext',
} as const;
