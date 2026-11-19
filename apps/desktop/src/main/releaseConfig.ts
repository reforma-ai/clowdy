// Replaced with literals by `scripts/main-bundle.ts` in a release build; absent from a development bundle.
declare const __CLOWDY_RELEASE_REPO__: string | undefined;
declare const __CLOWDY_SIGNED__: boolean | undefined;
declare const __CLOWDY_OTA_PUBLIC_KEY__: string | undefined;

/** Where this build's updates come from, as its build baked it in (`CLOWDY_RELEASE_REPO`, `CLOWDY_SIGNED`, `CLOWDY_OTA_PUBLIC_KEY`). */
export interface ReleaseConfig {
    /** `owner/name` of the GitHub repository whose releases update the app; empty turns updates off. */
    repo: string;
    /** The build carries a Developer ID signature, so Squirrel.Mac can install the next one over it. */
    signed: boolean;
    /** The Ed25519 key OTA manifests must be signed with (SPKI PEM); empty turns OTA bundles off. */
    otaPublicKey: string;
}

/** A packaged app uses only what its build baked in; a development run never updates its shell. */
export function releaseConfig(packaged: boolean): ReleaseConfig {
    if (!packaged) return { repo: '', signed: false, otaPublicKey: '' };

    return {
        repo: typeof __CLOWDY_RELEASE_REPO__ === 'string' ? __CLOWDY_RELEASE_REPO__ : '',
        signed: typeof __CLOWDY_SIGNED__ === 'boolean' && __CLOWDY_SIGNED__,
        otaPublicKey: typeof __CLOWDY_OTA_PUBLIC_KEY__ === 'string' ? __CLOWDY_OTA_PUBLIC_KEY__ : '',
    };
}
