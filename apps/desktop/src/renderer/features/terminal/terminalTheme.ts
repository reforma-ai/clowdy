import type { ITheme } from '@xterm/xterm';

/** The sixteen ANSI colors, One Dark on the dark plate and One Light on the light one: a program's red and green stay readable on either. */
const DARK_PALETTE = {
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e88a92',
    brightGreen: '#b1d68d',
    brightYellow: '#f0d399',
    brightBlue: '#82c0f4',
    brightMagenta: '#d495e6',
    brightCyan: '#79c7d1',
    brightWhite: '#ffffff',
    selectionBackground: 'rgba(97, 175, 239, 0.3)',
} satisfies ITheme;

const LIGHT_PALETTE = {
    black: '#383a42',
    red: '#e45649',
    green: '#50a14f',
    yellow: '#c18401',
    blue: '#4078f2',
    magenta: '#a626a4',
    cyan: '#0184bc',
    white: '#a0a1a7',
    brightBlack: '#696c77',
    brightRed: '#e45649',
    brightGreen: '#50a14f',
    brightYellow: '#c18401',
    brightBlue: '#4078f2',
    brightMagenta: '#a626a4',
    brightCyan: '#0184bc',
    brightWhite: '#fafafa',
    selectionBackground: 'rgba(64, 120, 242, 0.25)',
} satisfies ITheme;

/** The plate's own colors, read from the host's computed style, with the palette of the scheme the window is in. */
export function terminalTheme(style: Pick<CSSStyleDeclaration, 'backgroundColor' | 'color'>, dark: boolean): ITheme {
    return {
        ...(dark ? DARK_PALETTE : LIGHT_PALETTE),
        background: style.backgroundColor,
        foreground: style.color,
        cursor: style.color,
        cursorAccent: style.backgroundColor,
    };
}
