import { describe, expect, test } from 'vitest';

import { COMMIT_MESSAGE_SETTING_ID, writesCommitMessages } from './index';

import type { AgentInfo } from './index';

const codex = (patch: Partial<AgentInfo> = {}, value = true): AgentInfo => ({
    id: 'codex',
    name: 'Codex',
    custom: false,
    enabled: true,
    status: 'ready',
    launch: 'codex',
    signIn: { status: 'signed-in', checkedAt: 1 },
    settings: [{ id: COMMIT_MESSAGE_SETTING_ID, label: 'Commit messages', value, default: false }],
    ...patch,
});

describe('writesCommitMessages', () => {
    test('is a yes for an agent that is on, ready, signed in and has Commit messages on', () => {
        expect(writesCommitMessages(codex())).toBe(true);
    });

    test('is a no when the switch is off, there is no such switch, nobody is signed in or the daemon could not tell', () => {
        expect(writesCommitMessages(codex({}, false))).toBe(false);
        expect(writesCommitMessages(codex({ settings: [{ id: 'memory', label: 'Memory', value: true, default: false }] }))).toBe(false);
        expect(writesCommitMessages(codex({ settings: undefined }))).toBe(false);
        expect(writesCommitMessages(codex({ signIn: { status: 'signed-out', checkedAt: 1 } }))).toBe(false);
        expect(writesCommitMessages(codex({ signIn: { status: 'unknown', checkedAt: 1 } }))).toBe(false);
        expect(writesCommitMessages(codex({ signIn: undefined }))).toBe(false);
    });

    test('is a no for an agent that is switched off or cannot start', () => {
        expect(writesCommitMessages(codex({ enabled: false }))).toBe(false);
        expect(writesCommitMessages(codex({ status: 'missing' }))).toBe(false);
        expect(writesCommitMessages(codex({ status: 'needs-runtime' }))).toBe(false);
    });
});
