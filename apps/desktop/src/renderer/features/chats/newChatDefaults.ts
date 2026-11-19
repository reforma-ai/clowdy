import { LAST_USED } from '@clowdy/protocol';
import { makeAutoObservable } from 'mobx';

import { browserStorage, readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

import type { ChatMode, ProjectSettings } from '@clowdy/protocol';

const ENGINE_KEY = 'clowdy:new-chat-engine';
const MODE_KEY = 'clowdy:new-chat-mode';

const MODES: readonly ChatMode[] = ['autopilot', 'semi'];

/**
 * What a new chat starts with when its project follows the app (Settings > Chat > New chats), a preference of this computer: an agent and a mode, each
 * nothing for "Last used", where the last chat left off. The daemon never sees it; the message box applies it to the chats the person starts.
 */
export class NewChatDefaults {
    engine: string | undefined;
    mode: ChatMode | undefined;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage: KeyValueStorage | undefined) {
        this.#storage = storage;
        const engine = readStored(storage, ENGINE_KEY);

        this.engine = typeof engine === 'string' && engine !== '' ? engine : undefined;
        this.mode = MODES.find(mode => mode === readStored(storage, MODE_KEY));
        makeAutoObservable(this);
    }

    setEngine(engine: string | undefined): void {
        this.engine = engine;
        writeStored(this.#storage, ENGINE_KEY, engine ?? null);
    }

    setMode(mode: ChatMode | undefined): void {
        this.mode = mode;
        writeStored(this.#storage, MODE_KEY, mode ?? null);
    }
}

export const newChatDefaults = new NewChatDefaults(browserStorage());

/**
 * What a new chat in a project starts with: the project's own choice, the app's when the project follows it (nothing saved), and nothing for "Last used"
 * at either level, which the message box resolves from what was last picked on this computer.
 */
export function startingChoice(settings: ProjectSettings, app: { engine?: string; mode?: ChatMode }): { engine?: string; mode?: ChatMode } {
    const engine = settings.engine === undefined ? app.engine : settings.engine;
    const mode = settings.chatMode === undefined ? app.mode : settings.chatMode;

    return {
        ...(engine !== undefined && engine !== LAST_USED && { engine }),
        ...(mode !== undefined && mode !== LAST_USED && { mode }),
    };
}
