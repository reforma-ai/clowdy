import { browserStorage, readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

import type { ChatMode } from '@clowdy/protocol';

const STORAGE_KEY = 'clowdy:chat-mode';

const MODES: readonly ChatMode[] = ['autopilot', 'semi'];

/** The mode the person last picked on this machine, so a new chat can start where the last one left off. Nothing when none was picked or what is stored is not a mode. */
export function readRememberedMode(storage: KeyValueStorage | undefined = browserStorage()): ChatMode | undefined {
    const stored = readStored(storage, STORAGE_KEY);

    return MODES.find(mode => mode === stored);
}

export function writeRememberedMode(mode: ChatMode, storage: KeyValueStorage | undefined = browserStorage()): void {
    writeStored(storage, STORAGE_KEY, mode);
}

/** The mode a new chat starts in: the one its project asks for, else the one last picked, else Hands-off (`autopilot`). */
export function startingMode(projectMode: ChatMode | undefined, remembered: ChatMode | undefined): ChatMode {
    return projectMode ?? remembered ?? 'autopilot';
}
