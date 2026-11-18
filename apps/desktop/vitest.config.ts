import babel from 'vite-plugin-babel';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [
        // The design system's stores use native decorators (`@observableRef accessor`), which the renderer build compiles with this
        // plugin; without it any test that reaches a modal, a dialog or a menu through an import fails to load.
        babel({
            include: /\.(ts|tsx)$/,
            babelConfig: {
                babelrc: false,
                configFile: false,
                presets: [['@babel/preset-typescript', { onlyRemoveTypeImports: true, allowDeclareFields: true }]],
                plugins: [['@babel/plugin-proposal-decorators', { version: '2023-05' }]],
            },
        }),
    ],
    test: {
        // Component and DOM tests opt in with `// @vitest-environment happy-dom`.
        environment: 'node',
        include: ['src/**/*.test.{ts,tsx}'],
    },
});
