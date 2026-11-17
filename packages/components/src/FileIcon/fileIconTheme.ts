/// <reference types="vite/client" />

import { basename, splitPath } from '@clowdy/lib';
import manifest from 'material-icon-theme/dist/material-icons.json' with { type: 'json' };
import { createContext } from 'react';

export type FileIconKind = 'file' | 'directory';

/** One set of associations in a VS Code file icon theme. */
interface IconAssociations {
    fileExtensions?: Record<string, string>;
    fileNames?: Record<string, string>;
    folderNames?: Record<string, string>;
    folderNamesExpanded?: Record<string, string>;
    languageIds?: Record<string, string>;
}

/** The parts of a VS Code file icon theme manifest, such as Material Icon Theme's, that name icons. */
export interface IconThemeManifest extends IconAssociations {
    file: string;
    folder: string;
    folderExpanded: string;
    light?: IconAssociations;
}

export type ColorScheme = 'light' | 'dark';

/** The host's color scheme; icons pick their light variants from it. */
export const FileIconColorScheme = createContext<ColorScheme>('dark');

export interface IconOptions {
    /** The folder shows open. */
    open?: boolean;
    /** Light-theme variants win where the theme has them. */
    light?: boolean;
}

/** Languages VS Code itself gives these extensions, for themes that associate a language instead of the extension. */
const LANGUAGE_BY_EXTENSION = new Map([
    ['ts', 'typescript'],
    ['mts', 'typescript'],
    ['cts', 'typescript'],
    ['tsx', 'typescriptreact'],
    ['js', 'javascript'],
    ['mjs', 'javascript'],
    ['cjs', 'javascript'],
    ['jsx', 'javascriptreact'],
    ['css', 'css'],
    ['scss', 'scss'],
    ['json', 'json'],
    ['jsonc', 'jsonc'],
    ['md', 'markdown'],
    ['html', 'html'],
    ['yaml', 'yaml'],
    ['yml', 'yaml'],
    ['sh', 'shellscript'],
    ['txt', 'plaintext'],
]);

type AssociationMaps = Record<keyof IconAssociations, Map<string, string>>;

/** Lookups by lowercase key, as VS Code matches them; a `Map`, so a file named `constructor` finds nothing. */
function lookups(associations: IconAssociations = {}): AssociationMaps {
    const index = (record: Record<string, string> = {}) => new Map(Object.entries(record).map(([key, icon]) => [key.toLowerCase(), icon]));

    return {
        fileExtensions: index(associations.fileExtensions),
        fileNames: index(associations.fileNames),
        folderNames: index(associations.folderNames),
        folderNamesExpanded: index(associations.folderNamesExpanded),
        languageIds: index(associations.languageIds),
    };
}

/**
 * Names icons the way VS Code reads a file icon theme: a file by its name, then its longest
 * extension, then its language, then the default; a folder by its name, open or closed. A name may
 * also match with its parent folder (`.github/workflows`). Light variants come first in each step.
 */
export function createIconResolver(theme: IconThemeManifest) {
    const dark = lookups(theme);
    const light = lookups(theme.light);

    return (path: string, kind: FileIconKind, { open = false, light: isLight = false }: IconOptions = {}): string => {
        const sets = isLight ? [light, dark] : [dark];
        const find = (association: keyof IconAssociations, keys: readonly string[]): string | undefined => {
            for (const key of keys) {
                for (const set of sets) {
                    const icon = set[association].get(key);

                    if (icon) {
                        return icon;
                    }
                }
            }

            return undefined;
        };

        const [name = '', parent] = splitPath(path.toLowerCase()).reverse();
        const names = parent ? [`${ parent }/${ name }`, name] : [name];

        if (kind === 'directory') {
            return find(open ? 'folderNamesExpanded' : 'folderNames', names) ?? (open ? theme.folderExpanded : theme.folder);
        }

        // `page.test.tsx` → `test.tsx`, then `tsx`.
        const segments = name.split('.');
        const extensions = segments.slice(1).map((_, index) => segments.slice(index + 1).join('.'));
        const language = LANGUAGE_BY_EXTENSION.get(extensions.at(-1) ?? '');

        return find('fileNames', names)
            ?? find('fileExtensions', extensions)
            ?? (language === undefined ? undefined : find('languageIds', [language]))
            ?? theme.file;
    };
}

/** The Material Icon Theme name for a path. */
export const iconName = createIconResolver(manifest);

// One URL per SVG: each icon is its own hashed asset, fetched the first time it shows.
const svgUrls = import.meta.glob<string>('../../../../node_modules/material-icon-theme/icons/*.svg', {
    query: '?url&no-inline',
    import: 'default',
    eager: true,
});
const urlByFile = new Map(Object.entries(svgUrls).map(([file, url]) => [basename(file), url]));
const iconDefinitions: Record<string, { iconPath: string } | undefined> = manifest.iconDefinitions;

/** The URL of a named icon's SVG; `undefined` when the theme has no such icon. */
export function iconUrl(name: string): string | undefined {
    const definition = iconDefinitions[name];

    return definition && urlByFile.get(basename(definition.iconPath));
}
