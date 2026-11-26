import { describe, expect, it } from 'vitest';

import { worstOutcome } from './threadMessages';

describe('worstOutcome', () => {
    it('is the one outcome when the threads share it', () => {
        expect(worstOutcome([{ outcome: 'finished' }])).toBe('finished');
        expect(worstOutcome([{ outcome: 'failed' }, { outcome: 'failed' }])).toBe('failed');
        expect(worstOutcome([{ outcome: 'interrupted' }])).toBe('interrupted');
    });

    it('lets a failure show over an interruption, and an interruption over a finish', () => {
        expect(worstOutcome([{ outcome: 'finished' }, { outcome: 'interrupted' }])).toBe('interrupted');
        expect(worstOutcome([{ outcome: 'interrupted' }, { outcome: 'failed' }, { outcome: 'finished' }])).toBe(
            'failed'
        );
    });
});
