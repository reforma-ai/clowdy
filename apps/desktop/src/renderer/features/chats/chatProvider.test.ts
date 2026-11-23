import { describe, expect, it } from 'vitest';

import { createFixtureData } from '../../daemon/fixtureData';
import { chatProvider, chatWritability, handoffAgents } from './chatProvider';

import type { AgentInfo, Chat, Run } from '@clowdy/protocol';

const chat = (rest: Partial<Chat> = {}): Chat => ({
    id: 'c-1',
    projectId: 'p',
    title: 'Simplify booking',
    mode: 'autopilot',
    engine: 'claude',
    orchestratorRunId: 'r-1',
    createdAt: 0,
    updatedAt: 0,
    ...rest,
});
const run = (rest: Partial<Run> = {}) => ({ id: 'r-1', engine: 'claude', ...rest }) as Run;

/** The fixture's three agents, ready and signed in; a test changes the one it is about. */
function agents(change?: (claude: AgentInfo) => void): AgentInfo[] {
    const list = createFixtureData().agents;

    change?.(list.find(agent => agent.id === 'claude')!);

    return list;
}

const verdict = (
    list: AgentInfo[],
    target: Chat = chat(),
    orchestrator: Run | undefined = run(),
    status: 'loading' | 'ready' | 'failed' = 'ready'
) => chatWritability(target, orchestrator, list, status);

describe('chatWritability', () => {
    it('lets a chat on a ready, signed-in provider be written to', () => {
        expect(verdict(agents())).toEqual({ writable: true });
    });

    it("says a switched-off provider is turned off, by the agent's name", () => {
        expect(
            verdict(
                agents(claude => {
                    claude.enabled = false;
                    claude.status = 'disabled';
                })
            )
        ).toEqual({ writable: false, reason: 'disabled', message: 'Claude Code is turned off in Clowdy' });
    });

    it('calls a switched-off provider off even when its program is not there either', () => {
        expect(
            verdict(
                agents(claude => {
                    claude.enabled = false;
                    claude.status = 'missing';
                })
            )
        ).toMatchObject({ writable: false, reason: 'disabled' });
    });

    it('says a program that is not installed is not installed', () => {
        expect(
            verdict(
                agents(claude => {
                    claude.status = 'missing';
                })
            )
        ).toEqual({ writable: false, reason: 'not-installed', message: 'Claude Code is not installed' });
    });

    it('says an agent that needs the package runner needs Bun', () => {
        expect(
            verdict(
                agents(claude => {
                    claude.status = 'needs-runtime';
                })
            )
        ).toEqual({ writable: false, reason: 'needs-runtime', message: 'Claude Code needs Bun to start' });
    });

    it('says a provider nobody is signed in to is not signed in', () => {
        expect(
            verdict(
                agents(claude => {
                    claude.signIn = { status: 'signed-out', checkedAt: 1 };
                })
            )
        ).toEqual({ writable: false, reason: 'signed-out', message: 'Claude Code is not signed in' });
    });

    it('names the first reason that applies when several do: off, then not installed, then Bun, then signed out', () => {
        const signedOut = { status: 'signed-out', checkedAt: 1 } as const;

        expect(
            verdict(
                agents(claude => {
                    claude.enabled = false;
                    claude.status = 'disabled';
                    claude.signIn = signedOut;
                })
            )
        ).toMatchObject({ reason: 'disabled' });
        expect(
            verdict(
                agents(claude => {
                    claude.status = 'missing';
                    claude.signIn = signedOut;
                })
            )
        ).toMatchObject({ reason: 'not-installed' });
        expect(
            verdict(
                agents(claude => {
                    claude.status = 'needs-runtime';
                    claude.signIn = signedOut;
                })
            )
        ).toMatchObject({ reason: 'needs-runtime' });
    });

    it('follows the list: the same chat is read only on the reading that says signed out, and writable on the next one that says signed in', () => {
        const before = agents(claude => {
            claude.signIn = { status: 'signed-out', checkedAt: 1 };
        });
        const after = agents(claude => {
            claude.signIn = { status: 'signed-in', checkedAt: 2 };
        });

        expect(verdict(before)).toMatchObject({ writable: false, reason: 'signed-out' });
        expect(verdict(after)).toEqual({ writable: true });
    });

    it('says a provider that is not in the list at all is unknown, by its id', () => {
        const result = verdict(agents(), chat({ engine: 'my-agent' }), run({ engine: 'my-agent' }));

        expect(result).toEqual({
            writable: false,
            reason: 'unknown',
            message: 'This chat ran on "my-agent", which Clowdy no longer has',
        });
    });

    it('takes the provider from the orchestrator for a chat that does not record one', () => {
        const off = agents(claude => {
            claude.enabled = false;
            claude.status = 'disabled';
        });

        expect(chatProvider(chat({ engine: undefined }), run({ engine: 'codex' }))).toBe('codex');
        expect(chatProvider(chat({ engine: 'claude' }), run({ engine: 'codex' }))).toBe('claude');
        expect(verdict(off, chat({ engine: undefined }), run({ engine: 'claude' }))).toMatchObject({
            writable: false,
            reason: 'disabled',
        });
        // Codex is fine, so the chat that ran on it is too.
        expect(verdict(off, chat({ engine: undefined }), run({ engine: 'codex' }))).toEqual({ writable: true });
    });

    it('lets a chat with no orchestrator yet change its provider, whatever the one it holds', () => {
        const off = agents(claude => {
            claude.enabled = false;
            claude.status = 'disabled';
        });

        expect(verdict(off, chat({ orchestratorRunId: undefined }), undefined)).toEqual({ writable: true });
        expect(verdict(off, chat({ orchestratorRunId: undefined, engine: 'my-agent' }), undefined)).toEqual({
            writable: true,
        });
    });

    it('does not flash while the agents load, or when they could not be read', () => {
        const off = agents(claude => {
            claude.status = 'missing';
        });

        expect(verdict(off, chat(), run(), 'loading')).toEqual({ writable: true });
        expect(verdict(off, chat(), run(), 'failed')).toEqual({ writable: true });
        expect(verdict([], chat(), run(), 'loading')).toEqual({ writable: true });
    });

    it('counts an account that is not known, or not read yet, as signed in', () => {
        expect(
            verdict(
                agents(claude => {
                    claude.signIn = { status: 'unknown', checkedAt: 1, detail: 'The program did not answer' };
                })
            )
        ).toEqual({ writable: true });
        expect(
            verdict(
                agents(claude => {
                    delete claude.signIn;
                })
            )
        ).toEqual({ writable: true });
    });

    it('lets the chat go on when its provider is still being read', () => {
        // Nothing known about the agent yet: no usage, no account.
        expect(
            verdict(
                agents(claude => {
                    delete claude.signIn;
                    delete claude.usage;
                })
            )
        ).toEqual({ writable: true });
    });

    it('always lets the scripted demo agent answer, though the list does not have it', () => {
        expect(verdict(agents(), chat({ engine: 'fake' }), run({ engine: 'fake' }))).toEqual({ writable: true });
        expect(verdict([], chat({ engine: undefined }), run({ engine: 'fake' }))).toEqual({ writable: true });
    });

    it('lets a chat go on when nothing tells what it runs on', () => {
        expect(verdict(agents(), chat({ engine: undefined }), undefined)).toEqual({ writable: true });
    });
});

describe('handoffAgents', () => {
    const named = (list: AgentInfo[], target: Chat = chat(), orchestrator: Run | undefined = run()) =>
        handoffAgents(list, target, orchestrator).map(agent => agent.id);
    const change = (id: string, edit: (agent: AgentInfo) => void) => (list: AgentInfo[]) => {
        edit(list.find(agent => agent.id === id)!);

        return list;
    };

    it("lists the other agents in the order of the Providers page, without the chat's own", () => {
        expect(named(agents())).toEqual(['codex', 'cursor']);
        expect(named(agents(), chat({ engine: 'codex' }))).toEqual(['claude', 'cursor']);
    });

    it("takes the chat's own from its orchestrator for a chat from before chats kept an agent", () => {
        expect(named(agents(), chat({ engine: undefined }), run({ engine: 'claude' }))).toEqual(['codex', 'cursor']);
    });

    it('leaves out an agent that is signed out, switched off or not installed', () => {
        const signedOut = change('codex', codex => {
            codex.signIn = { status: 'signed-out', checkedAt: 0 };
        });
        const off = change('cursor', cursor => {
            cursor.enabled = false;
            cursor.status = 'disabled';
        });

        expect(named(signedOut(agents()))).toEqual(['cursor']);
        expect(named(off(agents()))).toEqual(['codex']);
        expect(
            named(
                change('codex', codex => {
                    codex.status = 'missing';
                })(agents())
            )
        ).toEqual(['cursor']);
    });

    it('keeps an agent whose account is not known yet: that is no reason to hold the person back', () => {
        expect(
            named(
                change('codex', codex => {
                    codex.signIn = { status: 'unknown', checkedAt: 0 };
                })(agents())
            )
        ).toEqual(['codex', 'cursor']);
        expect(
            named(
                change('codex', codex => {
                    delete codex.signIn;
                })(agents())
            )
        ).toEqual(['codex', 'cursor']);
    });

    it('is empty when no other agent can take it', () => {
        expect(named(agents().filter(agent => agent.id === 'claude'))).toEqual([]);
        expect(named([])).toEqual([]);
    });
});
