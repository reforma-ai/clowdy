import { describe, expect, test } from 'vitest';

import { parseUpdateStatus } from './bridge';

describe('parseUpdateStatus', () => {
    const status = { shell: '0.1.2', bundle: 250, ready: null, daemonWaiting: false };

    test('keeps a status as it is, with or without an update waiting', () => {
        expect(parseUpdateStatus(status)).toEqual(status);
        expect(parseUpdateStatus({ ...status, ready: 251, daemonWaiting: true })).toEqual({
            ...status,
            ready: 251,
            daemonWaiting: true,
        });
    });

    test('drops what the main process did not send', () => {
        expect(parseUpdateStatus({ ...status, extra: 'x' })).toEqual(status);
    });

    test.each([
        ['nothing', undefined],
        ['null', null],
        ['a number', 7],
        ['a version that is not text', { ...status, shell: 2 }],
        ['a bundle that is not a whole number', { ...status, bundle: 1.5 }],
        ['a bundle that is missing', { shell: '0.1.2', ready: null, daemonWaiting: false }],
        ['a waiting update that is not a whole number', { ...status, ready: '251' }],
        ['a waiting daemon that is not a flag', { ...status, daemonWaiting: 'yes' }],
    ])('rejects %s', (_name, value) => {
        expect(parseUpdateStatus(value)).toBeUndefined();
    });
});
