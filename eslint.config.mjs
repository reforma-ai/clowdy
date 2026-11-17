import base, { combine } from '@clowdy/eslint-config';

export default combine(base, {
    ignores: ['.turbo/**', 'apps/*/dist/**', 'apps/*/app/**', 'apps/*/release/**', 'packages/*/dist/**'],
});
