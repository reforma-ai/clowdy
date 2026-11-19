import { describe, expect, test } from 'vitest';

import { folderNames } from './domain';

const named = (...paths: string[]) => folderNames(paths.map(path => ({ path })));

describe('folderNames', () => {
    test('names each folder after the last part of its path, on any platform', () => {
        expect(named('/work/web', '/work/api/', 'C:\\code\\docs')).toEqual(['web', 'api', 'docs']);
    });

    test('numbers a name an earlier folder already has, and never repeats one', () => {
        expect(named('/a/app', '/b/app', '/c/app')).toEqual(['app', 'app-2', 'app-3']);
        expect(named('/a/app', '/b/app', '/c/app-2')).toEqual(['app', 'app-2', 'app-2-2']);
        expect(named('/c/app-2', '/a/app', '/b/app')).toEqual(['app-2', 'app', 'app-3']);
    });
});
