import type { Command, CommandType } from '@clowdy/protocol';
import type { Config } from '../config';
import type { DocsService } from '../docs/service';
import type { AgentRegistry } from '../engine/acp/registry';
import type { FilesService } from '../files/service';
import type { RunDriver } from '../runs/driver';
import type { RunService } from '../runs/service';
import type { SkillsService } from '../skills/service';
import type { Store } from '../store';

/** What a command handler may use. */
export interface Services {
    config: Config;
    store: Store;
    runs: RunService;
    driver: RunDriver;
    docs: DocsService;
    files: FilesService;
    skills: SkillsService;
    agents: AgentRegistry;
}

export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

/**
 * One handler per command type, run inside the transaction that also stores the command's result. Handlers are
 * synchronous and publish their events through the domain functions; the returned value is the result's `data`.
 */
export type Handlers = { [T in CommandType]: (services: Services, command: CommandOf<T>) => unknown };
