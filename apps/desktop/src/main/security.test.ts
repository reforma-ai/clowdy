import { describe, expect, test } from 'vitest';

import { hasLaunchSwitches } from './security';

describe('hasLaunchSwitches', () => {
    test('refuses any switch', () => {
        expect(hasLaunchSwitches(['--remote-debugging-port=9222'], 'darwin')).toBe(true);
        expect(hasLaunchSwitches(['-psn_0_1'], 'darwin')).toBe(true);
        expect(hasLaunchSwitches(['/user-data-dir=x'], 'win32')).toBe(true);
    });

    test('takes plain arguments and no arguments', () => {
        expect(hasLaunchSwitches([], 'darwin')).toBe(false);
        expect(hasLaunchSwitches(['/Users/me/project'], 'darwin')).toBe(false);
    });

    test('lets the Windows installer restart the app after an update', () => {
        expect(hasLaunchSwitches(['--updated'], 'win32')).toBe(false);
        expect(hasLaunchSwitches(['--updated', '--inspect'], 'win32')).toBe(true);
    });
});
