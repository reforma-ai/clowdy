import { describe, expect, it } from 'vitest';

import { errorCauseMessage, errorMessage, readErrorMessage } from '../src/errors';

describe('readErrorMessage', () => {
    it('trims and returns non-empty strings', () => {
        expect(readErrorMessage('  boom  ')).toBe('boom');
    });

    it('returns undefined for blank strings', () => {
        expect(readErrorMessage('   ')).toBeUndefined();
    });
});

describe('errorMessage', () => {
    it('reads Error.message', () => {
        expect(errorMessage(new Error('bad json'))).toBe('bad json');
    });

    it('uses fallback when message is missing', () => {
        expect(errorMessage({}, 'Normalize failed')).toBe('Normalize failed');
    });
});

describe('errorCauseMessage', () => {
    it('reads direct Error.cause', () => {
        const error = new Error('Normalize failed');

        error.cause = new SyntaxError('Unexpected token');

        expect(errorCauseMessage(error)).toBe('Unexpected token');
    });

    it('returns undefined when cause is absent', () => {
        expect(errorCauseMessage(new Error('nope'))).toBeUndefined();
    });
});
