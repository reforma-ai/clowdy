import { makeAutoObservable } from 'mobx';

import { browserStorage, readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

import type { Chat, Project } from '@clowdy/protocol';

const DISMISSED_KEY = 'clowdy:star-card-dismissed';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How old the person's Clowdy data is when the card first shows: they have been here a while. */
export const STAR_CARD_MIN_AGE_MS = 3 * DAY_MS;

/** How many chats the project on show has when the card first shows: they have used it, not only opened it. */
export const STAR_CARD_MIN_CHATS = 3;

/**
 * Whether the person has closed the Star on GitHub card, a fact of this computer: pressing its button or its cross is final, and nothing else (the menu item, the About page's
 * link) closes it. Kept as `ChatListPreferences` keeps its flags.
 */
export class StarCardPreferences {
    dismissed: boolean;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage: KeyValueStorage | undefined) {
        this.#storage = storage;
        this.dismissed = readStored(storage, DISMISSED_KEY) === true;
        makeAutoObservable(this);
    }

    dismiss(): void {
        this.dismissed = true;
        writeStored(this.#storage, DISMISSED_KEY, true);
    }
}

export const starCardPreferences = new StarCardPreferences(browserStorage());

/**
 * Whether the card is due: the oldest project (the personal space the daemon makes at its first start) is at least three days old and the project on show has at least three chats.
 * The chats are the ones the person made, archived ones too, and not the threads their agents started. It is not asked while the card is closed.
 */
export function starCardDue({ projects, chats, now }: {
    projects: readonly Pick<Project, 'createdAt'>[];
    chats: readonly Pick<Chat, 'parentChatId'>[];
    now: number;
}): boolean {
    if (projects.length === 0) return false;

    const born = Math.min(...projects.map(project => project.createdAt));

    return now - born >= STAR_CARD_MIN_AGE_MS && chats.filter(chat => chat.parentChatId === undefined).length >= STAR_CARD_MIN_CHATS;
}
