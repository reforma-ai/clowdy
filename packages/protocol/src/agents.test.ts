import { describe, expect, test } from 'vitest';

import { COMMIT_MESSAGE_SETTING_ID, commitMessageAgent, writesCommitMessages } from './index';

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

describe('commitMessageAgent', () => {
    test('chooses the provider configured in settings and prefers Codex for older profiles with both on', () => {
        const claude = codex({ id: 'claude' });
        const configuredCodex = codex({ signIn: { status: 'signed-out', checkedAt: 1 } });

        expect(commitMessageAgent([claude, configuredCodex])).toBe(configuredCodex);
        expect(commitMessageAgent([claude, codex({}, false)])).toBe(claude);
        expect(commitMessageAgent([codex({}, false)])).toBeUndefined();
        expect(commitMessageAgent([codex({ settings: undefined })])).toBeUndefined();
    });
});

describe('writesCommitMessages', () => {
    test('is a yes for a selected agent that is on, ready and signed in', () => {
        expect(writesCommitMessages(codex())).toBe(true);
    });

    test('is a no when no provider is selected or its sign-in is unconfirmed', () => {
        expect(writesCommitMessages(undefined)).toBe(false);
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
