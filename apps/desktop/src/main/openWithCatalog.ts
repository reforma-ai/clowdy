/**
 * The programs that can open a folder, which `openWith.ts` looks for on this computer. The order is the order of the choices, and the first editor found
 * is the one that opens a folder until the person picks another, so the most used come first. Adding one is adding a line.
 *
 * macOS finds an app by the name of its bundle in the Applications folders (`mac`, matched against the name without `.app`, so a channel or an
 * edition in the name still counts). Windows has no such list: each program has the places its installer puts it (`win`), where `%NAME%` is an
 * environment variable and a `*` in one part of a path matches any folder of that name. The Windows places are best effort and were not tried on a
 * Windows machine.
 */

export interface EditorSpec {
    id: string;
    name: string;
    mac: RegExp;
    win: readonly string[];
}

export interface FileManagerSpec {
    id: string;
    name: string;
    /** The one the system has: `shell.openPath` opens it, and it is always there. Only one has it, and it is first. */
    system?: boolean;
    mac?: RegExp;
}

const LOCAL = '%LOCALAPPDATA%\\Programs';
const FILES = '%ProgramFiles%';

/** A JetBrains IDE: in the Program Files folder of its installer, in the Programs folder of the user's, and in the apps of the Toolbox. */
function jetbrains(id: string, name: string, mac: RegExp, folder: string, exe: string, toolbox: string): EditorSpec {
    return {
        id,
        name,
        mac,
        win: [
            `${ FILES }\\JetBrains\\${ folder }*\\bin\\${ exe }`,
            `${ LOCAL }\\${ folder }*\\bin\\${ exe }`,
            `%LOCALAPPDATA%\\JetBrains\\Toolbox\\apps\\${ toolbox }\\ch-*\\*\\bin\\${ exe }`,
        ],
    };
}

export const EDITORS: readonly EditorSpec[] = [
    { id: 'cursor', name: 'Cursor', mac: /^Cursor$/, win: [`${ LOCAL }\\cursor\\Cursor.exe`] },
    { id: 'vscode', name: 'Visual Studio Code', mac: /^Visual Studio Code$/, win: [`${ LOCAL }\\Microsoft VS Code\\Code.exe`, `${ FILES }\\Microsoft VS Code\\Code.exe`] },
    { id: 'windsurf', name: 'Windsurf', mac: /^Windsurf/, win: [`${ LOCAL }\\Windsurf\\Windsurf.exe`] },
    { id: 'zed', name: 'Zed', mac: /^Zed( Preview)?$/, win: [`${ LOCAL }\\Zed\\Zed.exe`, `${ FILES }\\Zed\\Zed.exe`] },
    { id: 'antigravity', name: 'Antigravity', mac: /^Antigravity/, win: [`${ LOCAL }\\Antigravity\\Antigravity.exe`] },
    { id: 'kiro', name: 'Kiro', mac: /^Kiro$/, win: [`${ LOCAL }\\Kiro\\Kiro.exe`] },
    { id: 'trae', name: 'Trae', mac: /^Trae( CN)?$/, win: [`${ LOCAL }\\Trae\\Trae.exe`] },
    jetbrains('idea', 'IntelliJ IDEA', /^IntelliJ IDEA/, 'IntelliJ IDEA', 'idea64.exe', 'IDEA-*'),
    jetbrains('webstorm', 'WebStorm', /^WebStorm/, 'WebStorm', 'webstorm64.exe', 'WebStorm'),
    jetbrains('pycharm', 'PyCharm', /^PyCharm/, 'PyCharm', 'pycharm64.exe', 'PyCharm-*'),
    jetbrains('phpstorm', 'PhpStorm', /^PhpStorm/, 'PhpStorm', 'phpstorm64.exe', 'PhpStorm'),
    jetbrains('goland', 'GoLand', /^GoLand/, 'GoLand', 'goland64.exe', 'Goland'),
    jetbrains('rubymine', 'RubyMine', /^RubyMine/, 'RubyMine', 'rubymine64.exe', 'RubyMine'),
    jetbrains('clion', 'CLion', /^CLion/, 'CLion', 'clion64.exe', 'CLion'),
    jetbrains('rider', 'Rider', /^Rider/, 'JetBrains Rider', 'rider64.exe', 'Rider'),
    jetbrains('rustrover', 'RustRover', /^RustRover/, 'RustRover', 'rustrover64.exe', 'RustRover'),
    { id: 'android-studio', name: 'Android Studio', mac: /^Android Studio/, win: [`${ FILES }\\Android\\Android Studio*\\bin\\studio64.exe`, `${ LOCAL }\\Android Studio*\\bin\\studio64.exe`] },
    { id: 'sublime', name: 'Sublime Text', mac: /^Sublime Text/, win: [`${ FILES }\\Sublime Text*\\sublime_text.exe`] },
    { id: 'nova', name: 'Nova', mac: /^Nova$/, win: [] },
    { id: 'vscode-insiders', name: 'VS Code Insiders', mac: /^Visual Studio Code - Insiders$/, win: [`${ LOCAL }\\Microsoft VS Code Insiders\\Code - Insiders.exe`] },
    { id: 'vscodium', name: 'VSCodium', mac: /^VSCodium/, win: [`${ LOCAL }\\VSCodium\\VSCodium.exe`, `${ FILES }\\VSCodium\\VSCodium.exe`] },
    { id: 'positron', name: 'Positron', mac: /^Positron/, win: [`${ LOCAL }\\Positron\\Positron.exe`, `${ FILES }\\Positron\\Positron.exe`] },
    { id: 'theia', name: 'Theia IDE', mac: /^Theia/, win: [`${ LOCAL }\\TheiaIDE\\TheiaIDE.exe`, `${ LOCAL }\\Theia IDE\\Theia IDE.exe`] },
    { id: 'lapce', name: 'Lapce', mac: /^Lapce/, win: [`${ LOCAL }\\Lapce\\lapce.exe`, `${ FILES }\\Lapce\\lapce.exe`] },
    { id: 'pulsar', name: 'Pulsar', mac: /^Pulsar/, win: [`${ LOCAL }\\Pulsar\\Pulsar.exe`, '%LOCALAPPDATA%\\Pulsar\\Pulsar.exe'] },
];

/** The system's file manager is first, so it is the default and is never missing; on macOS the others are found by their app. */
export const FILE_MANAGERS = {
    darwin: [
        { id: 'finder', name: 'Finder', system: true },
        { id: 'path-finder', name: 'Path Finder', mac: /^Path Finder$/ },
        { id: 'forklift', name: 'ForkLift', mac: /^ForkLift/ },
    ],
    win32: [
        { id: 'explorer', name: 'File Explorer', system: true },
    ],
} as const satisfies Record<string, readonly FileManagerSpec[]>;

/** The folders where macOS apps are looked for: the system's, the user's, and where the JetBrains Toolbox puts the IDEs it installs. */
export const MAC_APP_FOLDERS = ['/Applications', '~/Applications', '~/Applications/JetBrains Toolbox'] as const;
