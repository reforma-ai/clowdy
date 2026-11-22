import { describe, expect, test } from 'vitest';

import { ROUTES } from './api';
import { isTerminalSize, TERMINAL_SUBPROTOCOL, terminalTokenProtocol, tokenFromTerminalProtocols } from './terminals';

describe('the token in a subprotocol', () => {
    test('comes back the way it went in, beside the protocol the daemon answers with', () => {
        const header = [TERMINAL_SUBPROTOCOL, terminalTokenProtocol('0a1b2c')].join(', ');

        expect(tokenFromTerminalProtocols(header)).toBe('0a1b2c');
    });

    test('survives characters a subprotocol could not carry as they are', () => {
        for (const token of ['a b/c+d=e', 'ключ-🔑', '']) {
            expect(terminalTokenProtocol(token)).toMatch(/^clowdy\.token\.[A-Za-z0-9_-]*$/);
            expect(tokenFromTerminalProtocols(terminalTokenProtocol(token))).toBe(token);
        }
    });

    test('is absent when the client offered none, and when what it offered is not a token', () => {
        expect(tokenFromTerminalProtocols(null)).toBeUndefined();
        expect(tokenFromTerminalProtocols(TERMINAL_SUBPROTOCOL)).toBeUndefined();
        expect(tokenFromTerminalProtocols('clowdy.token.%%%')).toBeUndefined();
        expect(tokenFromTerminalProtocols('clowdy.token.gA')).toBeUndefined();
    });
});

describe('isTerminalSize', () => {
    test('takes whole numbers within the limits', () => {
        expect(isTerminalSize(80, 24)).toBe(true);
        expect(isTerminalSize(2, 2)).toBe(true);
        expect(isTerminalSize(500, 200)).toBe(true);
    });

    test('refuses everything else', () => {
        expect(isTerminalSize(1, 24)).toBe(false);
        expect(isTerminalSize(80, 201)).toBe(false);
        expect(isTerminalSize(80.5, 24)).toBe(false);
        expect(isTerminalSize('80', 24)).toBe(false);
        expect(isTerminalSize(undefined, undefined)).toBe(false);
        expect(isTerminalSize(Number.NaN, 24)).toBe(false);
    });
});

describe('ROUTES', () => {
    test('a terminal is addressed by its id, made safe for a path', () => {
        expect(ROUTES.terminals).toBe('/v1/terminals');
        expect(ROUTES.terminal('trm_1')).toBe('/v1/terminals/trm_1');
        expect(ROUTES.terminalStream('a/b')).toBe('/v1/terminals/a%2Fb/stream');
    });
});
