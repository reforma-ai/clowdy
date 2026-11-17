/**
 * English count + noun with simple singular/plural forms (e.g. `1 file` / `2 files`).
 */
export function plural(count: number, singular: string, pluralForm: string): string {
    return `${ count } ${ count === 1 ? singular : pluralForm }`;
}

/**
 * Make first letter of string uppercase
 */
export const capitalize = (str: string) => {
    if (!str || typeof str !== 'string') {
        return str;
    }

    return str[0].toUpperCase() + str.slice(1, str.length);
};

/**
 * Turns a tool identifier (`snake_case`, `kebab-case`, `camelCase`, `PascalCase`, optional `mcp_` / `mcp-` prefix)
 * into sentence-case label text (e.g. `bare_echo` → `Bare echo`, `mcp_bareEcho` → `Bare echo`).
 */
export function humanizeString(raw: string): string {
    const trimmed = raw.trim();

    if (!trimmed) {
        return trimmed;
    }

    const withSpaces = trimmed
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .trim();

    const words = withSpaces.split(/\s+/).filter(Boolean);

    if (words.length === 0) {
        return capitalize(trimmed.toLowerCase());
    }

    const lower = words.map(w => w.toLowerCase()).join(' ');

    return capitalize(lower);
}

/**
 * Truncate string to specified length
 */
export const truncate = (str: string, maxLength: number, suffix: string = '...') => {
    if (!str || typeof str !== 'string') {
        return str;
    }

    return str.length > maxLength ? `${ str.slice(0, maxLength) }${ suffix }` : str;
};

/**
 * Prefix every line of a block with the same indentation string (no trim).
 */
export function indentBlock(text: string, indent: string): string {
    return text
        .split('\n')
        .map(line => `${ indent }${ line }`)
        .join('\n');
}

/**
 * Indents each line of text with the specified indentation string
 * @param text - The text to indent
 * @param indent - The indentation string (default: '  ')
 * @returns The indented text
 */
export const indentText = (text: string, indent: string = '  '): string => {
    if (!text || typeof text !== 'string') {
        return text;
    }

    return indentBlock(text.trim(), indent);
};

/** Leading space/tab run on a single line (for dedent and display normalization). */
export function leadingIndentLength(line: string): number {
    return /^([ \t]*)/.exec(line)?.[1]?.length ?? 0;
}

/** Leading Unicode whitespace run on a single line (for edit alignment). */
export function leadingWhitespaceLength(line: string | undefined): number {
    if (!line) {
        return 0;
    }

    return line.match(/^\s*/)?.[0]?.length ?? 0;
}

/** Strip up to `amount` leading spaces/tabs without eating non-indent characters. */
function stripLeadingIndent(line: string, amount: number): string {
    if (amount <= 0) {
        return line;
    }

    return line.slice(Math.min(amount, leadingIndentLength(line)));
}

/**
 * Remove shared leading indentation from a multi-line string.
 * Uses the minimum indent among non-empty lines so nested excerpts stay readable in narrow UI (e.g. chat code blocks).
 *
 * When the first content line is already flush-left (common after `.trim()` on an AST
 * excerpt) but every following content line shares a positive indent, strip that indent
 * instead — unless a later line is also flush (real top-level code like a closing `}`).
 */
export function dedentText(text: string): string {
    if (!text || typeof text !== 'string') {
        return text;
    }

    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const nonempty = lines.filter(line => line.trim().length > 0);

    if (nonempty.length === 0) {
        return text.trimEnd();
    }

    const indents = nonempty.map(line => leadingIndentLength(line));
    let minIndent = Math.min(...indents);

    if (minIndent === 0 && nonempty.length > 1) {
        const restIndents = indents.slice(1);
        const restMin = Math.min(...restIndents);

        if (restMin > 0) {
            minIndent = restMin;
        }
    }

    if (minIndent === 0) {
        return text.trimEnd();
    }

    return lines.map(line => stripLeadingIndent(line, minIndent)).join('\n').trimEnd();
}
