import babel from 'vite-plugin-babel';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [
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
        environment: 'node',
        include: ['specs/**/*.test.ts'],
    },
});
