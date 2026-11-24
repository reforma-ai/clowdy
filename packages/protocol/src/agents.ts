import type { EngineId } from './domain';

/**
 * Whether the daemon can start an agent now.
 * `ready`: its program is installed and, when it runs through an adapter, so is what fetches the adapter.
 * `missing`: the program is not on this machine. `needs-runtime`: the program is there but the package runner that
 * fetches its adapter (`bun x`) is not. `disabled`: switched off by the user.
 */
export type AgentStatus = 'ready' | 'missing' | 'needs-runtime' | 'disabled';

/** An agent the daemon knows about: a built-in entry, found or not, or one the user added. */
export interface AgentInfo {
    /** The id runs and project settings use (`claude`, `cursor`, `my-agent`). */
    id: EngineId;
    name: string;
    /** Added by the user rather than built in. */
    custom: boolean;
    enabled: boolean;
    status: AgentStatus;
    /** For a person: why the agent is not ready and what to install, or a note on how it starts. */
    detail?: string;
    /** The agent's program, as found on this machine. */
    path?: string;
    version?: string;
    /** How the daemon starts it, as a command line: `cursor-agent acp`, `bun x --bun @agentclientprotocol/codex-acp@2.8.0`. */
    launch: string;
    /** The package fetched on first start (an adapter), when there is one. Needs network once. */
    fetches?: string;
    /** The command a person runs in a terminal to sign in; shown when a run fails for lack of a login. */
    login?: string;
    /** Who is signed in to the agent on this machine. Absent until the daemon has asked, and for agents it cannot ask. */
    signIn?: AgentSignIn;
    /** The agent's subscription limits. Absent until read, and for agents that have none to read. */
    usage?: AgentUsage;
    /** Whether the daemon can run the agent's login for the person (`agent.signIn`). */
    canSignIn?: boolean;
    /** Whether the agent has a command that compacts its conversation, which `chat.compact` runs (Claude and Codex have one). */
    canCompact?: boolean;
    /** A sign-in the daemon is running or has just finished for this agent. */
    signInSession?: AgentSignInSession;
    /** The agent's own settings Clowdy can control, with their current values. Empty or absent when there are none. */
    settings?: AgentSetting[];
    /** The permission presets the agent's provider offers and the person's choice among them. Every agent has them (an agent with no declaration of its own offers `ask` and `full`). */
    permissions?: AgentPermissions;
    /** What the person changed about how the agent starts: a program they chose, variables they added. Absent when nothing was changed. */
    overrides?: AgentOverrides;
}

export interface AgentOverrides {
    path?: string;
    env?: Record<string, string>;
}

/** Whether somebody is signed in. `unknown`: the daemon could not tell (the program is missing or did not answer). */
export type SignInStatus = 'signed-in' | 'signed-out' | 'unknown';

/** The login of the agent on this machine: the one its own program uses, never an account Clowdy keeps. */
export interface AgentAccount {
    email?: string;
    /** A display name, when the vendor has one and there is no e-mail. */
    name?: string;
    organization?: string;
    /** The plan as the vendor names it (`Max`, `Plus`, `Pro+`). */
    plan?: string;
    /** `subscription` for a plan login, `api-key` for a key, `other` for anything else (a cloud provider, a token). */
    method?: 'subscription' | 'api-key' | 'other';
}

export interface AgentSignIn {
    status: SignInStatus;
    account?: AgentAccount;
    /** Epoch milliseconds of the last read. */
    checkedAt: number;
    /** Why the status is `unknown`, or a note such as which key the agent runs on. */
    detail?: string;
}

/** One meter of a plan: the 5-hour window, the weekly one, a weekly one for one model, a monthly plan. An agent lists them nearest first: the 5-hour window, then the weekly one, then the ones of single models. */
export interface AgentUsageWindow {
    /** Stable within an agent: `session`, `weekly`, `weekly:fable`, `plan`. */
    id: string;
    /** Short, as a row label: `Session`, `Week`, `Fable` (the weekly limit of one model), `Plan usage`. */
    label: string;
    /** 0-100, how much of the window is used. */
    usedPercent: number;
    /** Epoch milliseconds when the window resets. */
    resetsAt?: number;
}

export interface AgentUsage {
    /** `ok`: the windows are current. `unavailable`: there is nothing to show (an API key has no plan limits, the vendor offers no source). `error`: the last read failed; `windows` is the last good one, if any. */
    state: 'ok' | 'unavailable' | 'error';
    windows: AgentUsageWindow[];
    /** Epoch milliseconds of the last successful read. */
    fetchedAt?: number;
    /** What went wrong or why there is nothing to show, for a person. */
    detail?: string;
}

export type SignInStep = 'starting' | 'waiting' | 'done' | 'failed' | 'cancelled';

/**
 * A sign-in run by the daemon: the vendor's own login program, started for the person. The program opens the browser
 * itself; `url` is the link it printed, for copying into another browser.
 */
export interface AgentSignInSession {
    step: SignInStep;
    /** The sign-in link the program printed. */
    url?: string;
    /** A one-time code the person has to enter on the page (device sign-in). */
    code?: string;
    /** What happened, for a person: how it failed, or that it was cancelled. */
    message?: string;
    /** Epoch milliseconds the session started. */
    startedAt: number;
}

/**
 * The permission presets a person picks from: a closed vocabulary, so the settings read the same for every agent. A provider offers the subset
 * it can honour and writes its own description of each; a fifth preset is one more entry here.
 */
export const PERMISSION_PRESETS = ['ask', 'accept-edits', 'auto', 'full'] as const;

export type PermissionPresetId = (typeof PERMISSION_PRESETS)[number];

/** What a preset is called, whichever agent offers it. */
export const PERMISSION_PRESET_NAMES: Record<PermissionPresetId, string> = {
    ask: 'Ask for approval',
    'accept-edits': 'Accept edits',
    auto: 'Approve for me',
    full: 'Full access',
};

/** One preset an agent offers, with the agent's own description of what it does there. */
export interface AgentPermissionPreset {
    id: PermissionPresetId;
    name: string;
    description: string;
}

/** The permission presets of an agent, as its provider declares them. */
export interface AgentPermissions {
    /** In menu order. */
    presets: AgentPermissionPreset[];
    /** The person's choice. Absent when they have not chosen. */
    value?: PermissionPresetId;
    /** What the agent's provider starts it on when the person has not chosen. */
    default: PermissionPresetId;
}

/** A setting of an agent that Clowdy can turn on or off by itself (an environment variable or a session option). */
export interface AgentSetting {
    id: string;
    label: string;
    description?: string;
    value: boolean;
    /** The value when the person has not chosen. */
    default: boolean;
}

/** The stored setting behind the commit message provider choice. Older profiles may have it on for both agents. */
export const COMMIT_MESSAGE_SETTING_ID = 'commitMessage';

/** Codex was tried first when both providers were enabled. Keep that selection for older profiles. */
export const COMMIT_MESSAGE_PROVIDERS = ['codex', 'claude'] as const;
export type CommitMessageProvider = (typeof COMMIT_MESSAGE_PROVIDERS)[number];

/** The selected provider, regardless of whether it is ready to generate a message. */
export function commitMessageAgent(agents: readonly AgentInfo[]): AgentInfo | undefined {
    for (const id of COMMIT_MESSAGE_PROVIDERS) {
        const agent = agents.find(candidate => candidate.id === id);

        if (agent?.settings?.some(setting => setting.id === COMMIT_MESSAGE_SETTING_ID && setting.value)) return agent;
    }
}

/**
 * Whether the selected provider can write the message: it is enabled, ready and signed in. The daemon checks again when asked.
 */
export function writesCommitMessages(agent: AgentInfo | undefined): boolean {
    return agent?.enabled === true && agent.status === 'ready' && agent.signIn?.status === 'signed-in';
}

/** One model an agent offers, as its own program lists it on this machine and account. */
export interface AgentModel {
    /** What a run's `model` takes: Claude Code's `opus`, Codex's `gpt-5.5`, a Cursor model family such as `claude-opus-4-8` (its level is `effort`; an older Cursor lists variants such as `gpt-5.3-codex-high`). */
    id: string;
    name: string;
    description?: string;
    /** The model the agent runs when none is named. */
    isDefault?: boolean;
    /** The versioned model an alias stands for (`opus` is `claude-opus-5-5`), when the agent says. */
    resolvedId?: string;
    /** The reasoning efforts the model takes, as the agent spells them (`low`, `high`, `max`). Absent when it has no effort control or the agent does not say. */
    efforts?: string[];
    defaultEffort?: string;
    /** Whether the model has a faster, dearer mode. */
    supportsFast?: boolean;
    /** The agent's main models, for a picker that shows few and keeps the rest behind "more". Absent on every row when the agent does not say: a picker then takes the first rows. */
    featured?: boolean;
}

/** The answer of `GET /v1/agents/:id/models`. */
export interface AgentModels {
    /** `unavailable`: Clowdy has no way to list this agent's models (or it is not installed). `error`: the agent was asked and did not answer. */
    state: 'ok' | 'unavailable' | 'error';
    models: AgentModel[];
    /** Epoch milliseconds the list was read. */
    fetchedAt?: number;
    detail?: string;
}
