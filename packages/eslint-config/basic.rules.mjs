import { createRequire } from 'node:module';
import babelParser from '@babel/eslint-parser';
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import format from 'eslint-plugin-format';
import globals from 'globals';

import { combine } from './combine.mjs';

const require = createRequire(import.meta.url);

// Perfectionist loads `typescript` (workspace TS7 has no JS API). Point it at TS6.
try {
    const tsPath = require.resolve('typescript');
    if (typeof require.cache[tsPath]?.exports?.isExternalModuleNameRelative !== 'function') {
        require.cache[tsPath] = {
            id: tsPath,
            filename: tsPath,
            loaded: true,
            exports: require('@typescript/typescript6'),
            children: [],
            paths: [],
        };
    }
} catch {
    // no `typescript` in the project — sort-imports falls back to regex groups
}

const perfectionist = require('eslint-plugin-perfectionist');
const noopRule = { create: () => ({}) };
const leftoverDisablePlugin = ruleNames => ({
    rules: Object.fromEntries(ruleNames.map(name => [name, noopRule])),
});

const prettierCss = {
    parser: 'css',
    tabWidth: 4,
    semi: true,
    singleQuote: true,
    printWidth: 250,
};

const prettierLess = {
    ...prettierCss,
    parser: 'less',
};

/** Plain text parser for format/prettier on CSS/LESS (same shape as @antfu/eslint-config). */
const parserPlain = {
    meta: { name: 'parser-plain' },
    parseForESLint: code => ({
        ast: {
            type: 'Program',
            body: [],
            tokens: [],
            comments: [],
            range: [0, code.length],
            loc: { start: 0, end: code.length },
        },
        scopeManager: null,
        services: { isPlain: true },
        visitorKeys: {
            Program: [],
        },
    }),
};

const tsBabelOptions = {
    requireConfigFile: false,
    babelOptions: {
        babelrc: false,
        configFile: false,
        presets: [[require.resolve('@babel/preset-typescript'), { allowDeclareFields: true }]],
        plugins: [[require.resolve('@babel/plugin-proposal-decorators'), { version: '2023-05' }]],
    },
};

const jsTsFiles = ['**/*.{js,mjs,cjs,jsx,ts,tsx}'];

/** Same groups as @flexbe/eslint-config 3 (antfu + perfectionist 4). */
const sortImports = [
    'error',
    {
        type: 'alphabetical',
        order: 'asc',
        ignoreCase: false,
        internalPattern: ['^@/'],
        tsconfig: { rootDir: '' },
        groups: [
            ['value-builtin', 'value-external'],
            { newlinesBetween: 1 },
            'value-hash-aliases',
            { newlinesBetween: 0 },
            'value-internal',
            { newlinesBetween: 0 },
            'value-parent',
            { newlinesBetween: 0 },
            'value-sibling',
            { newlinesBetween: 0 },
            'value-index',
            { newlinesBetween: 1 },
            ['type-builtin', 'type-external'],
            { newlinesBetween: 0 },
            'type-hash-aliases',
            { newlinesBetween: 0 },
            'type-internal',
            { newlinesBetween: 0 },
            'type-parent',
            { newlinesBetween: 0 },
            'type-sibling',
            { newlinesBetween: 0 },
            'type-index',
            'unknown',
        ],
        customGroups: [
            {
                groupName: 'type-hash-aliases',
                elementNamePattern: '^#',
                modifiers: ['type'],
            },
            {
                groupName: 'value-hash-aliases',
                elementNamePattern: '^#',
                modifiers: ['value'],
            },
        ],
    },
];

const namedSort = {
    type: 'alphabetical',
    order: 'asc',
    ignoreCase: false,
};

/**
 * Shared base flat config. JS/TS syntax via Babel — no typescript-eslint
 * (incompatible with TypeScript 7 until 7.1). Format via stylistic + perfectionist.
 */
export default combine(
    {
        ignores: ['**/dist/**', '**/build/**', '**/.turbo/**', '**/node_modules/**', '**/coverage/**'],
    },
    js.configs.recommended,
    {
        plugins: {
            ts: leftoverDisablePlugin([
                'no-require-imports',
                'no-unsafe-declaration-merging',
                'promise-function-async',
                'no-redeclare',
            ]),
            import: leftoverDisablePlugin(['first']),
            style: leftoverDisablePlugin(['padding-line-between-statements', 'quotes']),
            react: leftoverDisablePlugin(['no-clone-element', 'no-children-only', 'no-children-count']),
            'react-dom': leftoverDisablePlugin(['no-flush-sync']),
        },
    },
    {
        files: jsTsFiles,
        languageOptions: {
            parser: babelParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
                ...tsBabelOptions,
            },
            globals: {
                ...globals.es2024,
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            'no-undef': 'off',
        },
    },
    {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            parser: babelParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
                ...tsBabelOptions,
            },
        },
        rules: {
            // Babel parser cannot distinguish `import type` — leave unused checks to tsc.
            'no-unused-vars': 'off',
            // Core rules assume Espree AST; Babel TS getters/overloads crash them.
            'getter-return': 'off',
            'no-dupe-args': 'off',
            'no-dupe-class-members': 'off',
            'no-redeclare': 'off',
        },
    },
    {
        files: jsTsFiles,
        plugins: {
            '@stylistic': stylistic,
        },
        rules: {
            // Babel has no TSEnumBody; stylistic would flatten enum members to column 0.
            '@stylistic/indent': [
                'error',
                4,
                {
                    SwitchCase: 1,
                    ignoredNodes: ['TSEnumDeclaration', 'TSEnumMember'],
                },
            ],
            '@stylistic/semi': ['error', 'always'],
            '@stylistic/quotes': ['error', 'single'],
            '@stylistic/brace-style': ['error', 'stroustrup'],
            '@stylistic/comma-dangle': [
                'error',
                {
                    arrays: 'always-multiline',
                    objects: 'always-multiline',
                    imports: 'only-multiline',
                    exports: 'only-multiline',
                    functions: 'never',
                },
            ],
            '@stylistic/eol-last': 'error',
            '@stylistic/no-trailing-spaces': 'error',
            '@stylistic/no-mixed-spaces-and-tabs': 'error',
            '@stylistic/jsx-quotes': ['error', 'prefer-double'],
            '@stylistic/jsx-indent-props': ['error', 4],
        },
    },
    {
        files: jsTsFiles,
        plugins: {
            perfectionist,
        },
        rules: {
            'perfectionist/sort-imports': sortImports,
            'perfectionist/sort-named-imports': [
                'error',
                {
                    ...namedSort,
                    groups: ['value-import', 'type-import'],
                },
            ],
            'perfectionist/sort-exports': [
                'error',
                {
                    ...namedSort,
                    groups: ['value-export', 'type-export'],
                },
            ],
            'perfectionist/sort-named-exports': [
                'error',
                {
                    ...namedSort,
                    groups: ['value-export', 'type-export'],
                },
            ],
        },
    },
    {
        plugins: {
            format,
        },
    },
    {
        files: ['**/*.css'],
        languageOptions: {
            parser: parserPlain,
        },
        rules: {
            'format/prettier': ['error', prettierCss],
        },
    },
    {
        files: ['**/*.less'],
        languageOptions: {
            parser: parserPlain,
        },
        rules: {
            'format/prettier': ['error', prettierLess],
        },
    }
);
