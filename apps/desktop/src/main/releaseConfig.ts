// Replaced with literals by `scripts/main-bundle.ts` in a release build; absent from a development bundle.
declare const __CLOWDY_RELEASE_REPO__: string | undefined;
declare const __CLOWDY_SIGNED__: boolean | undefined;
declare const __CLOWDY_OTA_PUBLIC_KEY__: string | undefined;

/** Where this build's updates come from, as its build baked it in (`CLOWDY_RELEASE_REPO`, `CLOWDY_SIGNED`, `CLOWDY_OTA_PUBLIC_KEY`). */
export interface ReleaseConfig {
    /** `owner/name` of the GitHub repository whose releases update the shell; empty turns shell updates off. */
    repo: string;
    /** The build carries a Developer ID signature, so Squirrel.Mac can install the next one over it. */
    signed: boolean;
    /** The Ed25519 key OTA manifests must be signed with (SPKI PEM); empty turns OTA bundles off. */
    otaPublicKey: string;
    /** Where `manifest.json` and the bundle archives are, without a trailing slash; empty turns OTA checks off. */
    otaFeed: string;
}

/**
 * A packaged app uses only what its build baked in, and finds OTA bundles in the repository's `ota` release. A development
 * run never updates its shell; it tries OTA bundles only against a test feed (`scripts/ota-local.ts`) when both
 * `CLOWDY_UPDATE_FEED` and `CLOWDY_UPDATE_PUBLIC_KEY` are set.
 */
export function releaseConfig(packaged: boolean, env: NodeJS.ProcessEnv = {}): ReleaseConfig {
    if (!packaged) {
        const { CLOWDY_UPDATE_FEED: feed = '', CLOWDY_UPDATE_PUBLIC_KEY: key = '' } = env;
        const testFeed = Boolean(feed && key);

        return { repo: '', signed: false, otaPublicKey: testFeed ? key : '', otaFeed: testFeed ? feed.replace(/\/+$/, '') : '' };
    }

    const repo = typeof __CLOWDY_RELEASE_REPO__ === 'string' ? __CLOWDY_RELEASE_REPO__ : '';

    return {
        repo,
        signed: typeof __CLOWDY_SIGNED__ === 'boolean' && __CLOWDY_SIGNED__,
        otaPublicKey: typeof __CLOWDY_OTA_PUBLIC_KEY__ === 'string' ? __CLOWDY_OTA_PUBLIC_KEY__ : '',
        // A release asset's stable address; GitHub redirects it to the file. No token: the repository is public.
        otaFeed: repo ? `https://github.com/${ repo }/releases/download/ota` : '',
    };
}
