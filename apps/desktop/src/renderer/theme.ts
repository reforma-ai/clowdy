/**
 * Follows the system appearance: `.dark` on `<html>` switches the design tokens. The window's native
 * material follows the system on its own; an appearance setting will pick light or dark through
 * `window.desktop.setThemeSource`, which keeps the material in step.
 */
export function initTheme(): void {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
        document.documentElement.classList.toggle('dark', query.matches);
        document.documentElement.style.colorScheme = query.matches ? 'dark' : 'light';
    };

    apply();
    query.addEventListener('change', apply);
}
