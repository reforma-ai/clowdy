import type { Command, CommandType } from '@clowdy/protocol';
import type { AttachmentsService } from '../attachments/service';
import type { Config } from '../config';
import type { DocsService } from '../docs/service';
import type { AgentRegistry } from '../engine/acp/registry';
import type { FilesService } from '../files/service';
import type { ModelCatalog } from '../providers/models';
import type { ProvidersService } from '../providers/service';
import type { RunDriver } from '../runs/driver';
import type { ChatQueue } from '../runs/queue';
import type { RunService } from '../runs/service';
import type { ThreadService } from '../runs/threads';
import type { SkillsService } from '../skills/service';
import type { Store } from '../store';

/** What a command handler may use. */
export interface Services {
    config: Config;
    store: Store;
    runs: RunService;
    driver: RunDriver;
    /** What the person writes while a chat's orchestrator works: the queue, its turns and its steers. */
    queue: ChatQueue;
    /** Threads: chats an agent of another chat starts and drives with its `thread_*` tools. */
    threads: ThreadService;
    docs: DocsService;
    files: FilesService;
    attachments: AttachmentsService;
    skills: SkillsService;
    agents: AgentRegistry;
    providers: ProvidersService;
    models: ModelCatalog;
}

export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

/**
 * One handler per command type, run inside the transaction that also stores the command's result. Handlers are
 * synchronous and publish their events through the domain functions; the returned value is the result's `data`.
 */
export type Handlers = { [T in CommandType]: (services: Services, command: CommandOf<T>) => unknown };
