import type { ShikiTransformer } from '@shikijs/types';

/** Serialized in `options.meta` between preprocess and line/pre hooks. */
type NotationMeta = {
    /** 1-based line index → class names */
    lines: Record<number, string[]>;
    hasAny: boolean;
};

const metaKeyDiff = '_clowdyNotationDiff';
const metaKeyHighlight = '_clowdyNotationHighlight';
const ZERO_WIDTH_SPACE = '\u200B';

// Require `//` before the marker so `[!code ++]` inside string literals is not stripped.
// (Upstream @shikijs/transformers parses comment tokens; we approximate with this prefix.)
const RE_DIFF = /\/\/\s*#?\s*\[!code\s*(\+\+|--)(:(\d+))?\]/gi;
const RE_HIGHLIGHT = /\/\/\s*#?\s*\[!code\s*(highlight|hl)(:(\d+))?\]/gi;

function mergeLineClasses(target: Map<number, Set<string>>, lineNum: number, classes: string[]): void {
    let set = target.get(lineNum);

    if (!set) {
        set = new Set();
        target.set(lineNum, set);
    }

    for (const c of classes) {
        set.add(c);
    }
}

function stripWithSpans(
    code: string,
    re: RegExp,
    lineClass: (kind: string, span: number, lineNum: number) => string[]
): { code: string; lineClasses: Map<number, Set<string>>; hasAny: boolean } {
    const lineClasses = new Map<number, Set<string>>();
    let hasAny = false;
    const lines = code.split(/\r?\n/);
    const out = lines.map((line, i) => {
        const lineNum = i + 1;
        const lineRe = new RegExp(re.source, re.flags);

        return line.replace(
            lineRe,
            (_full, kind: string, _colonPart: string | undefined, spanStr: string | undefined) => {
                hasAny = true;
                let spanRaw = 1;

                if (spanStr != null && spanStr !== '') {
                    spanRaw = Number.parseInt(spanStr, 10);
                }

                const span = Number.isFinite(spanRaw) && spanRaw > 0 ? spanRaw : 1;
                const classes = lineClass(kind.toLowerCase(), span, lineNum);

                for (let j = 0; j < span; j++) {
                    mergeLineClasses(lineClasses, lineNum + j, classes);
                }

                return '';
            }
        );
    });

    return { code: out.join('\n'), lineClasses, hasAny };
}

function lineClassesToRecord(map: Map<number, Set<string>>): Record<number, string[]> {
    const lines: Record<number, string[]> = {};

    for (const [k, set] of map) {
        lines[k] = [...set];
    }

    return lines;
}

function attachMeta(options: { meta?: Record<string, unknown> }, key: string, meta: NotationMeta): void {
    const bag = (options.meta ??= {});

    bag[key] = meta;
}

function readMeta(ctx: { options?: { meta?: Record<string, unknown> } }, key: string): NotationMeta | undefined {
    return ctx.options?.meta?.[key] as NotationMeta | undefined;
}

type NotationDiffOptions = {
    classLineAdd?: string;
    classLineRemove?: string;
    classActivePre?: string;
    classActiveCode?: string;
};

/**
 * `[!code ++]` / `[!code --]` on **raw source** (after `//`), then strip before highlight.
 * Prefer this over `@shikijs/transformers` `transformerNotationDiff` when comment tokenization
 * would drop or miss markers (JSDoc, empty lines, etc.). For the upstream implementation,
 * import `transformerNotationDiff` from `@shikijs/transformers` directly.
 */
export function transformerNotationDiff(options: NotationDiffOptions = {}): ShikiTransformer {
    const classLineAdd = options.classLineAdd ?? 'diff add';
    const classLineRemove = options.classLineRemove ?? 'diff remove';
    const classActivePre = options.classActivePre ?? 'has-diff';
    const classActiveCode = options.classActiveCode;

    return {
        name: 'clowdy:notation-diff',
        preprocess(code, opts) {
            const {
                code: next,
                lineClasses,
                hasAny,
            } = stripWithSpans(code, RE_DIFF, kind => (kind === '++' ? [classLineAdd] : [classLineRemove]));

            attachMeta(opts, metaKeyDiff, { lines: lineClassesToRecord(lineClasses), hasAny });

            return next || ZERO_WIDTH_SPACE;
        },
        line(node, lineNumber) {
            const meta = readMeta(this, metaKeyDiff);
            const list = meta?.lines[lineNumber];

            if (list) {
                for (const c of list) {
                    this.addClassToHast(node, c);
                }
            }

            return node;
        },
        pre(pre) {
            const meta = readMeta(this, metaKeyDiff);

            if (meta?.hasAny && classActivePre) {
                this.addClassToHast(pre, classActivePre);
            }

            return pre;
        },
        code(codeEl) {
            const meta = readMeta(this, metaKeyDiff);

            if (meta?.hasAny && classActiveCode) {
                this.addClassToHast(codeEl, classActiveCode);
            }

            return codeEl;
        },
    };
}

type NotationHighlightOptions = {
    classActiveLine?: string;
    classActivePre?: string;
    classActiveCode?: string;
};

/**
 * `[!code highlight]` / `[!code hl]` on raw source (after `//`)
 */
export function transformerNotationHighlight(options: NotationHighlightOptions = {}): ShikiTransformer {
    const classActiveLine = options.classActiveLine ?? 'highlighted';
    const classActivePre = options.classActivePre ?? 'has-highlighted';
    const classActiveCode = options.classActiveCode;

    return {
        name: 'clowdy:notation-highlight',
        preprocess(code, opts) {
            const {
                code: next,
                lineClasses,
                hasAny,
            } = stripWithSpans(code, RE_HIGHLIGHT, kind => {
                if (kind === 'highlight' || kind === 'hl') {
                    return [classActiveLine];
                }

                return [];
            });

            attachMeta(opts, metaKeyHighlight, { lines: lineClassesToRecord(lineClasses), hasAny });

            return next || ZERO_WIDTH_SPACE;
        },
        line(node, lineNumber) {
            const meta = readMeta(this, metaKeyHighlight);
            const list = meta?.lines[lineNumber];

            if (list) {
                for (const c of list) {
                    this.addClassToHast(node, c);
                }
            }

            return node;
        },
        pre(pre) {
            const meta = readMeta(this, metaKeyHighlight);

            if (meta?.hasAny && classActivePre) {
                this.addClassToHast(pre, classActivePre);
            }

            return pre;
        },
        code(codeEl) {
            const meta = readMeta(this, metaKeyHighlight);

            if (meta?.hasAny && classActiveCode) {
                this.addClassToHast(codeEl, classActiveCode);
            }

            return codeEl;
        },
    };
}
