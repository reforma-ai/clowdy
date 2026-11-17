import baseConfig, { combine } from '@clowdy/eslint-config';

export default combine(baseConfig, {
    ignores: ['dist/**', 'app/**', 'release/**'],
});
