import { makeAutoObservable } from 'mobx';

/**
 * The home folder of the person the daemon runs as, which `PathText` shows as `~`. One for the window: `RootStore` sets it when it loads the daemon's snapshot.
 * It is a value of its own, not a field to reach through the store's context, because a modal (Add project) stands outside the React tree of the app and still
 * draws paths. Unset until the daemon says, and for a daemon that does not: paths then show in full.
 */
class HomeFolder {
    path: string | undefined;

    constructor() {
        makeAutoObservable(this);
    }

    set(path: string | undefined): void {
        this.path = path;
    }
}

export const homeFolder = new HomeFolder();
