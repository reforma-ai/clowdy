// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTheme, initTheme, setTheme } from './theme';

function stubDarkSystem(dark: boolean) {
    vi.stubGlobal('matchMedia', () => ({ matches: dark, addEventListener: () => undefined }));
}

beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    window.desktop = undefined;
    stubDarkSystem(false);
});

describe('theme', () => {
    it('follows the system appearance by default', () => {
        stubDarkSystem(true);
        initTheme();

        expect(getTheme()).toBe('system');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('applies and remembers an explicit choice, whatever the system says', () => {
        stubDarkSystem(true);
        setTheme('light');

        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(localStorage.getItem('clowdy:theme')).toBe('light');

        initTheme();
        expect(getTheme()).toBe('light');
        expect(document.documentElement.style.colorScheme).toBe('light');
    });

    it('tells the window, so the native material follows', () => {
        const setThemeSource = vi.fn(async () => undefined);

        window.desktop = {
            platform: 'darwin',
            material: true,
            setThemeSource,
            chooseDirectories: async () => [],
            onDaemonChange: () => () => undefined,
            ready: async () => undefined,
            onUpdateReady: () => () => undefined,
            restartToUpdate: async () => undefined,
            findInPage: async () => ({ matches: 0, activeMatchOrdinal: 0 }),
            stopFind: async () => undefined,
            onFindCommand: () => () => undefined,
        };
        setTheme('dark');

        expect(setThemeSource).toHaveBeenCalledWith('dark');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('falls back to the system appearance when the stored value is unknown or storage throws', () => {
        localStorage.setItem('clowdy:theme', 'sepia');
        initTheme();
        expect(getTheme()).toBe('system');

        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        expect(() => initTheme()).not.toThrow();
        vi.restoreAllMocks();
    });
});
