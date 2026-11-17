import { defineConfig, presetMini, transformerDirectives } from 'unocss';

// Map spacing values to CSS variables (Tailwind-style with dots)
// Examples: m-0 → var(--spacing-0), m-1.5 → var(--spacing-6), m-1px → var(--spacing-1px)
// Also supports arbitrary values: m-[100px] → 100px (direct value)
function mapSpacing(value: string) {
    // If value is in brackets, use it directly (arbitrary value)
    if (value.startsWith('[') && value.endsWith(']')) {
        return decodeArbitraryValue(value.slice(1, -1));
    }

    if (value === 'auto') {
        return 'auto';
    }

    const cssVarValue = toSpacingTokenScale(value);
    const fallback = getSpacingFallback(cssVarValue);

    return fallback
        ? `var(--spacing-${ cssVarValue }, ${ fallback })`
        : `var(--spacing-${ cssVarValue })`;
}

function decodeArbitraryValue(value: string) {
    return value.replace(/_/g, ' ');
}

function toSpacingTokenScale(value: string) {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
        // 1-to-1 scale -> m-10 -> margin: var(--spacing-10)
        return formatScaleNumber(numeric);
    }

    return value;
}

function getSpacingFallback(scale: string) {
    if (scale === '0') {
        return '0px';
    }

    if (/^-?\d+(\.\d+)?$/.test(scale)) {
        return `${ scale }px`;
    }

    if (/^-?\d+(\.\d+)?px$/.test(scale)) {
        return scale;
    }

    return null;
}

function formatScaleNumber(value: number) {
    return Number.isInteger(value)
        ? String(value)
        : String(value).replace(/\.?0+$/, '');
}

function mapTokenVar(prefix: string, value: string) {
    if (value.startsWith('[') && value.endsWith(']')) {
        return decodeArbitraryValue(value.slice(1, -1));
    }

    return `var(--${ prefix }-${ value })`;
}

// Map radius values to CSS variables
// Examples: rounded-sm → var(--radius-sm), rounded-[8px] → 8px
function mapRadius(value: string) {
    return mapTokenVar('radius', value);
}

// Map leading (line-height) values to CSS variables
// Examples: leading-sm → var(--leading-sm), leading-[1.05] → 1.05
function mapLeading(value: string) {
    return mapTokenVar('leading', value);
}

// Map text size values to CSS variables
// Examples: text-sm → var(--text-sm), text-[68px] → 68px
function mapTextSize(value: string) {
    return mapTokenVar('text', value);
}

// Map semantic color tokens to CSS variables
// Examples: bg-primary → var(--color-primary), bg-[#fff] → #fff
function mapColor(value: string) {
    return mapTokenVar('color', value);
}

// Map opacity tokens to CSS variables
function mapOpacity(value: string) {
    return mapTokenVar('opacity', value);
}

// Map transition duration to CSS variables
function mapTransitionDuration(value: string) {
    return mapTokenVar('transition-duration', value);
}

// Map easing to CSS variables (--ease for default, --ease-* for named)
function mapEase(value: string) {
    if (value.startsWith('[') && value.endsWith(']')) {
        return decodeArbitraryValue(value.slice(1, -1));
    }

    return value === 'ease' ? 'var(--ease)' : `var(--ease-${ value })`;
}

// Map shadow to CSS variables
function mapShadow(value: string) {
    return mapTokenVar('shadow', value);
}

// Helper to create UnoCSS rules with cleaner syntax
// Extracts the value from the regex match automatically
function createRule(
    pattern: RegExp,
    handler: (value: string) => Record<string, string>
): [RegExp, (match: string[]) => Record<string, string>] {
    return [
        pattern,
        ([_, value]: string[]) => handler(value),
    ];
}

const spacingPx = Object.fromEntries(
    [...Array(512)].map((_, i) => [String(i), `var(--spacing-${ i }, ${ i }px)`])
);

export default defineConfig({
    presets: [presetMini({
        preflight: false,
        arbitraryVariants: false,
    })],
    transformers: [transformerDirectives()],
    theme: {
        width: spacingPx,
        height: spacingPx,
        maxWidth: spacingPx,
        maxHeight: spacingPx,
        minWidth: spacingPx,
        minHeight: spacingPx,
        inlineSize: spacingPx,
        blockSize: spacingPx,
        maxInlineSize: spacingPx,
        maxBlockSize: spacingPx,
        minInlineSize: spacingPx,
        minBlockSize: spacingPx,
    },
    rules: [
        // Margin all sides (supports arbitrary values: m-[100px])
        // Spacing capture is not `.+` — prose like `right-aligned.` would emit `var(--spacing-aligned.)` and break lightningcss minify.
        createRule(
            /^m-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ margin: mapSpacing(value) })
        ),
        // Margin top (supports arbitrary values: mt-[100px])
        createRule(
            /^mt-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ 'margin-top': mapSpacing(value) })
        ),
        // Margin bottom (supports arbitrary values: mb-[100px])
        createRule(
            /^mb-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ 'margin-bottom': mapSpacing(value) })
        ),
        // Margin left (supports arbitrary values: ml-[100px])
        createRule(
            /^ml-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ 'margin-left': mapSpacing(value) })
        ),
        // Margin right (supports arbitrary values: mr-[100px])
        createRule(
            /^mr-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ 'margin-right': mapSpacing(value) })
        ),
        // Margin horizontal (left and right) (supports arbitrary values: mx-[100px])
        createRule(
            /^mx-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({
                'margin-left': mapSpacing(value),
                'margin-right': mapSpacing(value),
            })
        ),
        // Margin vertical (top and bottom) (supports arbitrary values: my-[100px])
        createRule(
            /^my-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({
                'margin-top': mapSpacing(value),
                'margin-bottom': mapSpacing(value),
            })
        ),

        // Padding all sides (supports arbitrary values: p-[100px])
        createRule(
            /^p-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ padding: mapSpacing(value) })
        ),
        // Padding top (supports arbitrary values: pt-[100px])
        createRule(
            /^pt-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ 'padding-top': mapSpacing(value) })
        ),
        // Padding bottom (supports arbitrary values: pb-[100px])
        createRule(
            /^pb-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ 'padding-bottom': mapSpacing(value) })
        ),
        // Padding left (supports arbitrary values: pl-[100px])
        createRule(
            /^pl-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ 'padding-left': mapSpacing(value) })
        ),
        // Padding right (supports arbitrary values: pr-[100px])
        createRule(
            /^pr-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ 'padding-right': mapSpacing(value) })
        ),
        // Padding horizontal (left and right) (supports arbitrary values: px-[100px])
        createRule(
            /^px-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({
                'padding-left': mapSpacing(value),
                'padding-right': mapSpacing(value),
            })
        ),
        // Padding vertical (top and bottom) (supports arbitrary values: py-[100px])
        createRule(
            /^py-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({
                'padding-top': mapSpacing(value),
                'padding-bottom': mapSpacing(value),
            })
        ),

        // Gap (all directions) (supports arbitrary values: gap-[100px])
        createRule(
            /^gap-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ gap: mapSpacing(value) })
        ),
        // Gap horizontal (column-gap) (supports arbitrary values: gap-x-[100px])
        createRule(
            /^gap-x-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ 'column-gap': mapSpacing(value) })
        ),
        // Gap vertical (row-gap) (supports arbitrary values: gap-y-[100px])
        createRule(
            /^gap-y-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ 'row-gap': mapSpacing(value) })
        ),

        // Border radius all corners
        createRule(
            /^rounded-(.+)$/,
            value => ({ 'border-radius': mapRadius(value) })
        ),
        // Border radius top
        createRule(
            /^rounded-t-(.+)$/,
            value => ({
                'border-top-left-radius': mapRadius(value),
                'border-top-right-radius': mapRadius(value),
            })
        ),
        // Border radius bottom
        createRule(
            /^rounded-b-(.+)$/,
            value => ({
                'border-bottom-left-radius': mapRadius(value),
                'border-bottom-right-radius': mapRadius(value),
            })
        ),
        // Border radius left
        createRule(
            /^rounded-l-(.+)$/,
            value => ({
                'border-top-left-radius': mapRadius(value),
                'border-bottom-left-radius': mapRadius(value),
            })
        ),
        // Border radius right
        createRule(
            /^rounded-r-(.+)$/,
            value => ({
                'border-top-right-radius': mapRadius(value),
                'border-bottom-right-radius': mapRadius(value),
            })
        ),
        // Border radius top-left
        createRule(
            /^rounded-tl-(.+)$/,
            value => ({ 'border-top-left-radius': mapRadius(value) })
        ),
        // Border radius top-right
        createRule(
            /^rounded-tr-(.+)$/,
            value => ({ 'border-top-right-radius': mapRadius(value) })
        ),
        // Border radius bottom-left
        createRule(
            /^rounded-bl-(.+)$/,
            value => ({ 'border-bottom-left-radius': mapRadius(value) })
        ),
        // Border radius bottom-right
        createRule(
            /^rounded-br-(.+)$/,
            value => ({ 'border-bottom-right-radius': mapRadius(value) })
        ),

        // Line height
        createRule(
            /^leading-(.+)$/,
            value => ({ 'line-height': mapLeading(value) })
        ),

        // Text size
        createRule(
            /^text-(.+)$/,
            (value: string): Record<string, string> => {
                switch (value) {
                    case 'bold':
                        return { 'font-weight': '700' };
                    case 'normal':
                        return { 'font-weight': '400' };
                    case 'medium':
                        return { 'font-weight': '500' };
                    case 'semibold':
                        return { 'font-weight': '600' };
                    case 'light':
                        return { 'font-weight': '300' };
                }

                return { 'font-size': mapTextSize(value) };
            }
        ),

        // Inset (positioning) all sides (supports arbitrary values: inset-[100px])
        createRule(
            /^inset-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ inset: mapSpacing(value) })
        ),
        // Inset horizontal (left and right) (supports arbitrary values: inset-x-[100px])
        createRule(
            /^inset-x-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({
                left: mapSpacing(value),
                right: mapSpacing(value),
            })
        ),
        // Inset vertical (top and bottom) (supports arbitrary values: inset-y-[100px])
        createRule(
            /^inset-y-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({
                top: mapSpacing(value),
                bottom: mapSpacing(value),
            })
        ),
        // Top (supports arbitrary values: top-[100px])
        createRule(
            /^top-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ top: mapSpacing(value) })
        ),
        // Right (supports arbitrary values: right-[100px])
        createRule(
            /^right-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ right: mapSpacing(value) })
        ),
        // Bottom (supports arbitrary values: bottom-[100px])
        createRule(
            /^bottom-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ bottom: mapSpacing(value) })
        ),
        // Left (supports arbitrary values: left-[100px])
        createRule(
            /^left-(\[.+\]|auto|-?\d+(?:\.\d+)?(?:px)?|[a-z]+)$/,
            value => ({ left: mapSpacing(value) })
        ),

        // Background color (semantic tokens)
        createRule(
            /^bg-(.+)$/,
            value => ({ 'background-color': mapColor(value) })
        ),
        // Text/content color (semantic tokens)
        createRule(
            /^color-(.+)$/,
            value => ({ color: mapColor(value) })
        ),
        // Border color (semantic tokens)
        createRule(
            /^border-color-(.+)$/,
            value => ({ 'border-color': mapColor(value) })
        ),
        // Fill (SVG, semantic tokens)
        createRule(
            /^fill-(.+)$/,
            value => ({ fill: mapColor(value) })
        ),

        // Opacity (tokens: disabled, inactive, hover, placeholder)
        createRule(
            /^opacity-(.+)$/,
            value => ({ opacity: mapOpacity(value) })
        ),

        // Transition duration (tokens: fast, slow)
        createRule(
            /^duration-(.+)$/,
            value => ({ 'transition-duration': mapTransitionDuration(value) })
        ),
        // Transition timing (tokens: linear, in-out, bounce)
        createRule(
            /^ease-(.+)$/,
            value => ({ 'transition-timing-function': mapEase(value) })
        ),

        // Box shadow (tokens: xs, sm, md, lg, xl). Capture is not `.+` —
        // `shadow-color:${id}` is scanned as `shadow-color:$` and emits
        // `var(--shadow-color:$)`, which lightningcss rejects.
        createRule(
            /^shadow-(\[.+\]|[a-z0-9]+)$/,
            value => ({ 'box-shadow': mapShadow(value) })
        ),

        // Single-line ellipsis; `inline-block` so max-width/width constrain the box.
        // Overrides presetMini's `truncate`, so all properties must be listed here.
        ['truncate', {
            display: 'inline-block',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
        }],
    ],
    safelist: [
        ...['xxs', 'xs', 'sm', 'md', 'lg', 'xl'].flatMap(v =>
            ['m', 'mt', 'mb', 'ml', 'mr', 'mx', 'my', 'p', 'pt', 'pb', 'pl', 'pr', 'px', 'py', 'gap', 'gap-x', 'gap-y', 'inset', 'inset-x', 'inset-y', 'top', 'right', 'bottom', 'left'].map(p => `${ p }-${ v }`)
        ),
        ...['xs', 'sm', 'md', 'lg', 'xl', 'full'].flatMap(v =>
            ['rounded', 'rounded-t', 'rounded-b', 'rounded-l', 'rounded-r', 'rounded-tl', 'rounded-tr', 'rounded-bl', 'rounded-br'].map(p => `${ p }-${ v }`)
        ),
        ...['xs', 'sm', 'md', 'lg', 'xl', 'xxl'].flatMap(v => [`leading-${ v }`, `text-${ v }`]),
        ...['xs', 'sm'].map(v => `shadow-${ v }`),
        ...['fast', 'slow'].map(v => `duration-${ v }`),
        ...['ease', 'linear', 'in-out', 'bounce'].map(v => `ease-${ v }`),
        ...['disabled', 'inactive', 'hover', 'placeholder'].map(v => `opacity-${ v }`),
        ...['hidden', 'auto', 'scroll', 'visible', 'clip'].flatMap(v => [
            `overflow-${ v }`,
            `overflow-x-${ v }`,
            `overflow-y-${ v }`,
        ]),
        'truncate',
    ],
});
