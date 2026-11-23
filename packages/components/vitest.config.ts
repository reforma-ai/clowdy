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
        include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
        // Makes happy-dom's cancelled animations as quiet as a browser's (see the file).
        setupFiles: ['./src/vitest.setup.ts'],
    },
});
