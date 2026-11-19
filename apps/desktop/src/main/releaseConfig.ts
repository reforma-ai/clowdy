// Replaced with literals by `scripts/main-bundle.ts` in a release build; absent from a development bundle.
declare const __CLOWDY_RELEASE_REPO__: string | undefined;
declare const __CLOWDY_SIGNED__: boolean | undefined;

/** Where this build's updates come from, as its build baked it in (`CLOWDY_RELEASE_REPO`, `CLOWDY_SIGNED`). */
export interface ReleaseConfig {
    /** `owner/name` of the GitHub repository whose releases update the app; empty turns updates off. */
    repo: string;
    /** The build carries a Developer ID signature, so Squirrel.Mac can install the next one over it. */
    signed: boolean;
}

/** A packaged app uses only what its build baked in; a development run never updates its shell. */
export function releaseConfig(packaged: boolean): ReleaseConfig {
    if (!packaged) return { repo: '', signed: false };

    return {
        repo: typeof __CLOWDY_RELEASE_REPO__ === 'string' ? __CLOWDY_RELEASE_REPO__ : '',
        signed: typeof __CLOWDY_SIGNED__ === 'boolean' && __CLOWDY_SIGNED__,
    };
}
