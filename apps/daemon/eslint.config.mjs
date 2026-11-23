import baseConfig, { combine } from '@clowdy/eslint-config';

export default combine(baseConfig, {
    files: ['**/*.{js,mjs,cjs,ts}'],
    rules: {
        // The root of `@clowdy/lib` re-exports its React and DOM helpers, so one import of it loads them into a Bun process that has neither. Its files are imported by subpath.
        'no-restricted-imports': [
            'error',
            {
                paths: [
                    {
                        name: '@clowdy/lib',
                        message:
                            'The root of @clowdy/lib pulls in React and DOM code, which the daemon never runs. Import the file you need by its subpath, such as @clowdy/lib/checklist.',
                    },
                ],
            },
        ],
    },
});
