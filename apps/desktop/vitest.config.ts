import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Component and DOM tests opt in with `// @vitest-environment happy-dom`.
        environment: 'node',
        include: ['src/**/*.test.{ts,tsx}'],
    },
});
