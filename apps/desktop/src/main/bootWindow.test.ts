import { describe, expect, test, vi } from 'vitest';

import { bootPage, progressScript } from './bootWindow';

vi.mock('electron', () => ({ BrowserWindow: class {}, nativeTheme: {} }));

describe('bootPage', () => {
    test('is a static page with a labeled progress bar and a policy that runs no script', () => {
        const page = bootPage();

        expect(page).toMatch(/role="progressbar"[^>]*aria-label="[^"]+"/);
        expect(page).toContain('Content-Security-Policy');
        expect(page).not.toContain('<script');
    });
});

describe('progressScript', () => {
    test.each([
        [0, 0],
        [0.426, 43],
        [1, 100],
        [1.5, 100],
        [-1, 0],
        [Number.NaN, 0],
    ])('moves the bar for %s to %s percent', (fraction, percent) => {
        const script = progressScript(fraction);

        expect(script).toContain(`'aria-valuenow', '${ percent }'`);
        expect(script).toContain(`width = '${ percent }%'`);
    });
});
