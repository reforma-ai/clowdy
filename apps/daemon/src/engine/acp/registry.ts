import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { AGENT_ID, KNOWN_AGENTS } from './catalog';
import { Discovery } from './discovery';
import { buildAgentEnv } from './env';

import type { AgentInfo, AgentSetting } from '@clowdy/protocol';
import type { AgentOverride, AgentSettingSpec, AgentSpec, CustomAgent, SettingEffect } from './catalog';

/** Detection results are reused this long, so a settings screen can poll without spawning a probe each time. */
const INFO_TTL_MS = 30_000;

/** Fetching an adapter must not download an agent bundled inside it, and must not stop to ask anything. */
/** Asks the package manager to leave optional packages out, so an adapter's bundled copy of its agent is not downloaded. `bun x` may not honor it; the adapters are pointed at the user's own program either way. */
const PACKAGE_RUNNER_ENV = { npm_config_omit: 'optional' };

/** What a run needs to start an agent. */
export interface ResolvedAgent {
    id: string;
    name: string;
    /** The user's own program for the agent, as found on this machine (for an adapter, the program the adapter drives). */
    program: string;
    command: string;
    args: string[];
    /** Variables to start it with, after the user's own environment. */
    env: Record<string, string>;
    /** Variables it must not inherit. */
    scrub: RegExp[];
    login?: string;
    /** The `_meta` of `session/new`, for the options its adapter reads. */
    sessionMeta?: Record<string, unknown>;
}

export type Resolution = { ok: true; agent: ResolvedAgent } | { ok: false; message: string };

interface Stored {
    agents: CustomAgent[];
    overrides: Record<string, AgentOverride>;
}

export interface AgentRegistryOptions {
    /** Where `agents.json` lives. Without it the registry keeps nothing on disk (tests). */
    dataDir?: string;
    discovery?: Discovery;
    now?: () => number;
    /** The Bun that runs adapter packages with `bun x`: the daemon's own by default, since the daemon runs on Bun. Tests replace it. */
    runtime?: () => Promise<string | undefined>;
}

export class AgentRegistryError extends Error {
    constructor(readonly kind: 'invalid' | 'not_found' | 'conflict', message: string) {
        super(message);
    }
}

/**
 * The agents the daemon can run: the built-in catalog plus the ones the user added, with what the user changed about
 * each. It finds their programs on this machine and says what is missing; it starts nothing itself.
 */
export class AgentRegistry {
    private stored: Stored = { agents: [], overrides: {} };
    private cache?: { at: number; infos: Promise<AgentInfo[]> };
    private discovery: Discovery;
    private now: () => number;
    private runtime: () => Promise<string | undefined>;
    private file?: string;

    constructor(options: AgentRegistryOptions = {}) {
        this.discovery = options.discovery ?? new Discovery();
        this.now = options.now ?? Date.now;
        this.runtime = options.runtime ?? (async () => process.versions.bun ? process.execPath : (await this.discovery.find(['bun']))?.path);

        if (options.dataDir) {
            this.file = join(options.dataDir, 'agents.json');
            this.stored = this.load(this.file);
        }
    }

    /** The search path agents get (the login shell's). */
    path(): Promise<string> {
        return this.discovery.path();
    }

    /** Whether `id` names an agent, installed or not. Cheap and synchronous: a run on a missing agent fails with a message instead. */
    has(id: string): boolean {
        return this.spec(id) !== undefined || this.stored.agents.some(agent => agent.id === id);
    }

    /** Whether the person left `id` switched on in Clowdy (an agent that is not known counts as on). Synchronous, for refusing a message before a run exists. */
    isEnabled(id: string): boolean {
        return this.stored.overrides[id]?.enabled !== false;
    }

    nameOf(id: string): string {
        return this.spec(id)?.name ?? this.stored.agents.find(agent => agent.id === id)?.name ?? id;
    }

    /** Every agent with its state on this machine. */
    list(): Promise<AgentInfo[]> {
        if (!this.cache || this.now() - this.cache.at > INFO_TTL_MS) {
            this.cache = { at: this.now(), infos: Promise.all(this.entries().map(entry => this.describe(entry))) };
        }

        return this.cache.infos;
    }

    /** Looks again: the next `list` and `resolve` search anew, for when the user installed something. */
    refresh(): void {
        this.discovery.refresh();
        this.cache = undefined;
    }

    /** What to start for `id`, or why it cannot be started. Always searches the machine afresh for the program. */
    async resolve(id: string): Promise<Resolution> {
        const entry = this.entries().find(candidate => candidate.id === id);

        return entry ? this.build(entry) : { ok: false, message: `There is no agent called "${ id }"` };
    }

    /**
     * What a read of the agent's account needs: its program and the environment a run of it gets (so a probe sees the
     * `CLAUDE_CONFIG_DIR` or `CODEX_HOME` a run would). `undefined` for an agent that is off or not installed.
     */
    async probeTarget(id: string, daemonEnv: Record<string, string | undefined> = process.env): Promise<{ program: string; env: Record<string, string> } | undefined> {
        const resolution = await this.resolve(id);

        if (!resolution.ok) {
            return undefined;
        }

        const { agent } = resolution;

        return { program: agent.program, env: buildAgentEnv({ daemonEnv, path: await this.path(), scrub: agent.scrub, set: agent.env }) };
    }

    /* -------------------------------- Changing -------------------------------- */

    add(agent: CustomAgent): void {
        if (!AGENT_ID.test(agent.id)) {
            throw new AgentRegistryError('invalid', 'An agent id is lowercase letters, digits and dashes, starting with a letter or digit, at most 32 characters');
        }

        if (agent.id === 'fake' || this.has(agent.id)) {
            throw new AgentRegistryError('conflict', `An agent called "${ agent.id }" already exists`);
        }

        if (!agent.name.trim() || !agent.command.trim()) {
            throw new AgentRegistryError('invalid', 'An agent needs a name and a command');
        }

        checkProgram(agent.command.trim());
        this.change(() => this.stored.agents.push({ ...agent, name: agent.name.trim(), command: agent.command.trim() }));
    }

    update(id: string, patch: Omit<AgentOverride, 'path'> & { path?: string | null; name?: string; command?: string; args?: string[] }): void {
        const custom = this.stored.agents.find(agent => agent.id === id);

        if (!custom && !this.spec(id)) {
            throw new AgentRegistryError('not_found', `There is no agent called "${ id }"`);
        }

        const { name, command, args, path, enabled, env, settings } = patch;

        for (const settingId of Object.keys(settings ?? {})) {
            if (!this.spec(id)?.settings?.some(setting => setting.id === settingId)) {
                throw new AgentRegistryError('invalid', `${ this.nameOf(id) } has no setting called "${ settingId }"`);
            }
        }

        if (path) {
            checkProgram(path, true);
        }

        if (command?.trim() && custom) {
            checkProgram(command.trim());
        }

        this.change(() => {
            if (custom) {
                Object.assign(custom, { ...(name?.trim() && { name: name.trim() }), ...(command?.trim() && { command: command.trim() }), ...(args && { args }) });
            }

            // Only what the patch names changes; a field left out (or passed as `undefined`) keeps its value.
            const next: AgentOverride = {
                ...this.stored.overrides[id],
                ...(enabled !== undefined && { enabled }),
                ...(env !== undefined && { env }),
                ...(settings !== undefined && { settings: { ...this.stored.overrides[id]?.settings, ...settings } }),
            };

            if (path === null) {
                delete next.path;
            }
            else if (path !== undefined) {
                next.path = path;
            }

            this.stored.overrides[id] = next;
        });
    }

    remove(id: string): void {
        if (!this.stored.agents.some(agent => agent.id === id)) {
            throw new AgentRegistryError(this.spec(id) ? 'invalid' : 'not_found', this.spec(id) ? `${ this.nameOf(id) } is built in; switch it off instead` : `There is no custom agent called "${ id }"`);
        }

        this.change(() => {
            this.stored.agents = this.stored.agents.filter(agent => agent.id !== id);
            delete this.stored.overrides[id];
        });
    }

    /* -------------------------------- Resolving ------------------------------- */

    private spec(id: string): AgentSpec | undefined {
        return KNOWN_AGENTS.find(spec => spec.id === id);
    }

    private entries(): Entry[] {
        return [
            ...KNOWN_AGENTS.map(spec => ({ id: spec.id, name: spec.name, custom: false as const, spec })),
            ...this.stored.agents.map(agent => ({ id: agent.id, name: agent.name, custom: true as const, agent })),
        ];
    }

    /** The program that shows `entry` is installed: the user's chosen path, else the first of the usual names found. */
    private async program(entry: Entry): Promise<string | undefined> {
        const chosen = this.stored.overrides[entry.id]?.path;

        if (chosen) {
            return existsSync(chosen) ? chosen : undefined;
        }

        if (entry.custom) {
            return isAbsolute(entry.agent.command) ? (existsSync(entry.agent.command) ? entry.agent.command : undefined) : (await this.discovery.find([entry.agent.command]))?.path;
        }

        return (await this.discovery.find(entry.spec.programs))?.path;
    }

    private async build(entry: Entry): Promise<Resolution> {
        const override = this.stored.overrides[entry.id] ?? {};

        if (!this.isEnabled(entry.id)) {
            return { ok: false, message: `${ entry.name } is switched off in Clowdy` };
        }

        const program = await this.program(entry);

        if (!program) {
            return { ok: false, message: entry.custom ? `The command "${ entry.agent.command }" of ${ entry.name } was not found` : `${ entry.name } is not installed: no \`${ entry.spec.programs[0] }\` command was found. Install it, then try again` };
        }

        if (entry.custom) {
            return { ok: true, agent: { id: entry.id, name: entry.name, program, command: program, args: entry.agent.args, env: { ...entry.agent.env, ...override.env }, scrub: [] } };
        }

        const { spec } = entry;
        const applied = appliedSettings(spec, override);
        const base = { id: spec.id, name: spec.name, scrub: spec.scrub ?? [], login: spec.login, sessionMeta: withDisallowedTools(spec.sessionMeta, applied.disallowedTools) };

        if (spec.launch.kind === 'binary') {
            return { ok: true, agent: { ...base, program, command: program, args: spec.launch.args, env: withoutRemoved({ ...spec.env, ...applied.env, ...override.env }) } };
        }

        const runtime = await this.runtime();

        if (!runtime) {
            return { ok: false, message: `${ spec.name } needs Bun: its adapter is fetched with \`bun x\`, and no bun was found. Install Bun, then try again` };
        }

        return {
            ok: true,
            agent: { ...base, program, command: runtime, args: ['x', '--bun', spec.launch.package], env: withoutRemoved({ ...PACKAGE_RUNNER_ENV, ...spec.env, ...applied.env, [spec.launch.pathEnv]: program, ...override.env }) },
        };
    }

    private async describe(entry: Entry): Promise<AgentInfo> {
        const override = this.stored.overrides[entry.id] ?? {};
        const resolution = await this.build(entry);
        const program = await this.program(entry);
        const spec = entry.custom ? undefined : entry.spec;
        const fetches = spec?.launch.kind === 'package' ? spec.launch.package : undefined;
        const launch = entry.custom ? [entry.agent.command, ...entry.agent.args].join(' ') : launchLine(entry.spec);
        const enabled = this.isEnabled(entry.id);
        const missingRunner = program !== undefined && !resolution.ok && enabled;

        return {
            id: entry.id,
            name: entry.name,
            custom: entry.custom,
            enabled,
            status: !enabled ? 'disabled' : resolution.ok ? 'ready' : missingRunner ? 'needs-runtime' : 'missing',
            ...(!resolution.ok && enabled && { detail: resolution.message }),
            ...(program && { path: program }),
            ...(program && { version: await this.discovery.version(program) }),
            launch,
            ...(fetches && { fetches }),
            ...(spec?.login && { login: spec.login }),
            ...(spec?.settings?.length && { settings: settingsOf(spec, override) }),
            ...((override.path || override.env) && { overrides: { ...(override.path && { path: override.path }), ...(override.env && { env: override.env }) } }),
        };
    }

    /* -------------------------------- Persisting ------------------------------ */

    private load(file: string): Stored {
        try {
            return parseStored(JSON.parse(readFileSync(file, 'utf8')));
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.warn(`[clowdy] ${ file } could not be read; custom agents and agent settings are ignored: ${ (error as Error).message }`);
            }

            return { agents: [], overrides: {} };
        }
    }

    /** Applies a change and writes it. A change that cannot be written is not kept in memory either. */
    private change(mutate: () => void): void {
        const before = structuredClone(this.stored);

        try {
            mutate();
            this.save();
        }
        catch (error) {
            this.stored = before;

            throw error;
        }

        this.cache = undefined;
    }

    private save(): void {
        if (!this.file) {
            return;
        }

        mkdirSync(dirname(this.file), { recursive: true });
        // A write that dies half-way must not leave a file nobody can read. The file may hold keys the user gave an agent.
        writeFileSync(`${ this.file }.tmp`, JSON.stringify(this.stored, null, 2), { mode: 0o600 });
        renameSync(`${ this.file }.tmp`, this.file);
    }

}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every(item => typeof item === 'string');

/**
 * A program is a name looked up on the search path or an absolute path. A relative path would be read against whatever
 * folder the daemon happens to run in, and against the project's when it starts.
 */
function checkProgram(program: string, pathOnly = false): void {
    if (isAbsolute(program) || (!pathOnly && !/[\\/]/.test(program))) {
        return;
    }

    throw new AgentRegistryError('invalid', pathOnly ? 'A path to a program must be absolute' : 'A command is a program name or an absolute path');
}

/** Reads `agents.json` for what it is worth: whatever is damaged or foreign in it is left out, the rest is kept. */
function parseStored(data: unknown): Stored {
    const record = isRecord(data) ? data : {};
    const known = new Set(['fake', ...KNOWN_AGENTS.map(spec => spec.id)]);
    const agents = new Map<string, CustomAgent>();

    for (const entry of Array.isArray(record.agents) ? record.agents : []) {
        if (!isRecord(entry) || typeof entry.id !== 'string' || !AGENT_ID.test(entry.id) || known.has(entry.id) || agents.has(entry.id) || typeof entry.command !== 'string' || !entry.command.trim()) {
            continue;
        }

        const name = typeof entry.name === 'string' ? entry.name.trim() : '';

        agents.set(entry.id, {
            id: entry.id,
            name: name || entry.id,
            command: entry.command.trim(),
            args: Array.isArray(entry.args) ? entry.args.map(String) : [],
            ...(isStrings(entry.env) && { env: entry.env }),
        });
    }

    const overrides: Record<string, AgentOverride> = {};

    for (const [id, value] of Object.entries(isRecord(record.overrides) ? record.overrides : {})) {
        if (isRecord(value)) {
            overrides[id] = {
                ...(typeof value.enabled === 'boolean' && { enabled: value.enabled }),
                ...(typeof value.path === 'string' && value.path !== '' && { path: value.path }),
                ...(isStrings(value.env) && { env: value.env }),
                ...(isRecord(value.settings) && { settings: Object.fromEntries(Object.entries(value.settings).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')) }),
            };
        }
    }

    return { agents: [...agents.values()], overrides };
}

const settingValue = (setting: AgentSettingSpec, override: AgentOverride): boolean => override.settings?.[setting.id] ?? setting.default;

/** The agent's settings with their values, for a person to see and change. */
function settingsOf(spec: AgentSpec, override: AgentOverride): AgentSetting[] {
    return (spec.settings ?? []).map(setting => ({ id: setting.id, label: setting.label, description: setting.description, value: settingValue(setting, override), default: setting.default }));
}

/** What the settings, at their values, do to the environment and the tools of the agent. A later setting wins over an earlier one. */
function appliedSettings(spec: AgentSpec, override: AgentOverride): Required<SettingEffect> {
    const applied: Required<SettingEffect> = { env: {}, disallowedTools: [] };

    for (const setting of spec.settings ?? []) {
        const effect = setting.effect(settingValue(setting, override));

        Object.assign(applied.env, effect.env);
        applied.disallowedTools.push(...effect.disallowedTools ?? []);
    }

    return applied;
}

/** The environment with the variables a setting removed (`null`) taken out. */
function withoutRemoved(env: Record<string, string | null>): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== null));
}

/** The agent's `_meta` for `session/new`, with the tools its settings take away added to the ones the catalog already withholds. */
function withDisallowedTools(meta: Record<string, unknown> | undefined, extra: string[]): Record<string, unknown> | undefined {
    if (extra.length === 0) {
        return meta;
    }

    const claudeCode = isRecord(meta?.claudeCode) ? meta.claudeCode : {};
    const options = isRecord(claudeCode.options) ? claudeCode.options : {};
    const already = Array.isArray(options.disallowedTools) ? options.disallowedTools as string[] : [];

    return { ...meta, claudeCode: { ...claudeCode, options: { ...options, disallowedTools: [...new Set([...already, ...extra])] } } };
}

/** How an agent starts, as a person would type it. */
function launchLine({ launch, programs }: AgentSpec): string {
    switch (launch.kind) {
        case 'package':
            return `bun x --bun ${ launch.package }`;
        case 'binary':
            return [programs[0], ...launch.args].join(' ');
    }
}

type Entry =
    | { id: string; name: string; custom: false; spec: AgentSpec }
    | { id: string; name: string; custom: true; agent: CustomAgent };
