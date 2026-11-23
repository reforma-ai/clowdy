import { THEMES, type Theme } from '@clowdy/constants';

const THEME_KEY = 'clowdy:theme';

let theme: Theme = 'system';

function readStoredTheme(): Theme {
    try {
        const stored = localStorage.getItem(THEME_KEY);

        return THEMES.find(candidate => candidate === stored) ?? 'system';
    } catch {
        return 'system';
    }
}

/** `.dark` on `<html>` switches the design tokens; `system` follows the OS appearance. */
function apply(): void {
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function getTheme(): Theme {
    return theme;
}

/** Applies and remembers the appearance, and tells the window so its native material follows. */
export function setTheme(next: Theme): void {
    theme = next;

    try {
        localStorage.setItem(THEME_KEY, next);
    } catch {
        // The choice still applies for this session.
    }

    apply();
    void window.desktop?.setThemeSource(next);
}

/** Restores the remembered appearance and keeps `system` in step with the OS. */
export function initTheme(): void {
    theme = readStoredTheme();
    apply();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
    void window.desktop?.setThemeSource(theme);
}
