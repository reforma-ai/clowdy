/**
 * The programs that can open a folder (editors, terminals, file managers), which `openWith.ts` looks for on this computer. The order is the order of the
 * choices, and the first program of a kind found is the one that opens a folder until the person picks another, so the most used come first. Adding one is
 * adding a line.
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

export interface TerminalSpec {
    id: string;
    name: string;
    mac?: RegExp;
    win: readonly string[];
    /**
     * The arguments that open a window in the folder. Without them macOS hands the folder to the app (`open -a`, which Terminal, iTerm2, Ghostty and
     * Warp take as "a window here"); with them it starts a new instance of the app (`open -n -a`, so the arguments reach it even when it runs).
     */
    args?: (folder: string) => readonly string[];
}

export interface FileManagerSpec {
    id: string;
    name: string;
    /** The one the system has: `shell.openPath` opens it, and it is always there. Only one has it, and it is first. */
    system?: boolean;
    /** Where the icon of the system's own file manager is read from, since it is not found as an app; a place may name `%NAME%` as `win` does. */
    icon?: string;
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

/** `wt` splits every argument at a `;` and runs what follows as another command of its own, so a folder with one in its name cannot be handed to it. */
function windowsTerminalArgs(folder: string): readonly string[] {
    if (folder.includes(';')) throw new Error('Windows Terminal cannot open a folder with a semicolon in its name');

    return ['-d', folder];
}

/**
 * The terminals, a person's own before the system's, since the first one found is the default until another is picked and anyone who installed one wants
 * it over Terminal. A console program (PowerShell, `cmd`) is not here for Windows: started without a console of its own it ends at once, and Windows
 * Terminal runs them. No terminal here was started by this code on either system: the arguments are the ones each program documents.
 */
export const TERMINALS: readonly TerminalSpec[] = [
    { id: 'iterm', name: 'iTerm2', mac: /^iTerm/, win: [] },
    { id: 'ghostty', name: 'Ghostty', mac: /^Ghostty$/, win: [] },
    { id: 'warp', name: 'Warp', mac: /^Warp/, win: [] },
    { id: 'wezterm', name: 'WezTerm', mac: /^WezTerm$/, win: [`${ FILES }\\WezTerm\\wezterm-gui.exe`], args: folder => ['start', '--cwd', folder] },
    { id: 'alacritty', name: 'Alacritty', mac: /^Alacritty$/, win: [`${ FILES }\\Alacritty\\alacritty.exe`, `${ LOCAL }\\Alacritty\\alacritty.exe`], args: folder => ['--working-directory', folder] },
    { id: 'kitty', name: 'kitty', mac: /^kitty$/, win: [], args: folder => ['--directory', folder] },
    { id: 'windows-terminal', name: 'Windows Terminal', win: ['%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe'], args: windowsTerminalArgs },
    { id: 'git-bash', name: 'Git Bash', win: [`${ FILES }\\Git\\git-bash.exe`, `${ LOCAL }\\Git\\git-bash.exe`], args: folder => [`--cd=${ folder }`] },
    { id: 'terminal', name: 'Terminal', mac: /^Terminal$/, win: [] },
];

/** The system's file manager is first, so it is the default and is never missing; on macOS the others are found by their app. */
export const FILE_MANAGERS = {
    darwin: [
        { id: 'finder', name: 'Finder', system: true, icon: '/System/Library/CoreServices/Finder.app' },
        { id: 'path-finder', name: 'Path Finder', mac: /^Path Finder$/ },
        { id: 'forklift', name: 'ForkLift', mac: /^ForkLift/ },
    ],
    win32: [
        { id: 'explorer', name: 'File Explorer', system: true, icon: '%SystemRoot%\\explorer.exe' },
    ],
} as const satisfies Record<string, readonly FileManagerSpec[]>;

/** The folders where macOS apps are looked for: the system's, the user's, where the JetBrains Toolbox puts the IDEs it installs, and where macOS keeps Terminal. */
export const MAC_APP_FOLDERS = ['/Applications', '~/Applications', '~/Applications/JetBrains Toolbox', '/System/Applications/Utilities'] as const;
