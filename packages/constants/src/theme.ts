/** Appearance choices; `system` follows the OS. */
export const THEMES = ['light', 'dark', 'system'] as const;

export type Theme = (typeof THEMES)[number];
