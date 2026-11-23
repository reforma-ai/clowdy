import { createRequire } from 'node:module';
import babelParser from '@babel/eslint-parser';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

import basicRules from './basic.rules.mjs';
import { combine } from './combine.mjs';

export { combine };

const require = createRequire(import.meta.url);

const reactBabelOptions = {
    requireConfigFile: false,
    babelOptions: {
        babelrc: false,
        configFile: false,
        presets: [
            [require.resolve('@babel/preset-typescript'), { allowDeclareFields: true }],
            [require.resolve('@babel/preset-react'), { runtime: 'automatic' }],
        ],
        plugins: [[require.resolve('@babel/plugin-proposal-decorators'), { version: '2023-05' }]],
    },
};

export default combine(basicRules, {
    files: ['**/*.{jsx,tsx}'],
    languageOptions: {
        parser: babelParser,
        parserOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            ...reactBabelOptions,
        },
        globals: {
            ...globals.es2024,
            ...globals.browser,
        },
    },
    plugins: {
        'react-hooks': reactHooks,
        'react-refresh': reactRefresh,
    },
    rules: {
        ...reactHooks.configs.recommended.rules,
        // Existing effects reset local state; don't fail --quiet / lint-staged.
        'react-hooks/set-state-in-effect': 'warn',
        // Co-exporting constants/helpers next to components is normal in this repo.
        'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
});
