import type { Configuration, FileSet } from 'electron-builder';

/**
 * `owner/name` of the repository with the releases (`.github/workflows/release-shell.yml` sets it). Only then does
 * electron-builder write `app-update.yml`, the GitHub feed electron-updater reads, so a local build never updates itself.
 */
const releaseRepo = process.env.CLOWDY_RELEASE_REPO;
const [owner, repo] = releaseRepo?.split('/') ?? [];

/**
 * The native runtime the daemon needs outside the ASAR: Bun and the ripgrep beside it. The app copies it out of the
 * install folder before it starts the daemon (`src/main/bundle.ts`). Named per platform here:
 * `${platform}` would expand to the build host's.
 */
function daemonResources(platform: 'darwin' | 'win32'): FileSet[] {
    return [
        // electron-builder expands `${arch}`, not TypeScript.
        { from: `runtime/${platform}-\${arch}`, to: 'bun' },
    ];
}

// Packages the app/ folder that scripts/build.ts lays out. The identity below should be settled
// before the first release: updates, the Keychain item behind cookie encryption, and userData depend on it.
export default {
    appId: 'app.clowdy.desktop',
    productName: 'Clowdy',

    directories: {
        app: 'app',
        output: 'release',
        buildResources: 'build',
    },

    // Everything is bundled, so the app has no dependencies to install, rebuild, or pack.
    npmRebuild: false,
    asar: true,
    files: ['package.json', 'dist/**', '!node_modules/**'],

    // electron-builder expands these macros, not TypeScript.
    artifactName: '${productName}-${version}-${arch}.${ext}',
    ...(owner && repo && { publish: { provider: 'github', owner, repo } }),

    // Flipped before signing, so the signature keeps them from being flipped back.
    electronFuses: {
        runAsNode: false,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        grantFileProtocolExtraPrivileges: false,
        enableCookieEncryption: true,
        enableEmbeddedAsarIntegrityValidation: true,
        onlyLoadAppFromAsar: true,
    },

    // `bun run package` and `package:win` build unpacked apps (`--dir`). A release (`release:mac`) builds the dmg people
    // install from and the zip the updater installs, for both architectures in one run so one latest-mac.yml covers both.
    // It signs with the Developer ID from CSC_LINK and notarizes with the App Store Connect key in APPLE_API_KEY (a path to
    // the .p8), APPLE_API_KEY_ID, and APPLE_API_ISSUER; without them the workflow signs ad hoc.
    mac: {
        category: 'public.app-category.developer-tools',
        icon: 'build/icon.png',
        hardenedRuntime: true,
        entitlements: 'build/entitlements.mac.plist',
        // Every other Mach-O in the bundle, Bun and ripgrep included, is signed with these.
        entitlementsInherit: 'build/entitlements.mac.inherit.plist',
        notarize: false,
        target: ['dmg', 'zip'],
        extraResources: daemonResources('darwin'),
    },

    // Signed with the app's Developer ID (on a runner without one, the ad-hoc build leaves them unsigned). The release
    // workflow notarizes and staples them after electron-builder, which changes their hashes, so they stay out of
    // latest-mac.yml. Named without the version, so `releases/latest/download/Clowdy-arm64.dmg` always works.
    dmg: {
        artifactName: '${productName}-${arch}.${ext}',
        sign: true,
        writeUpdateInfo: false,
    },

    // Unsigned for now: SmartScreen names no publisher until the builds are signed.
    win: {
        icon: 'build/icon.png',
        target: ['nsis-web'],
        extraResources: daemonResources('win32'),
    },

    // Per user under %LOCALAPPDATA%\Programs, so neither the install nor an update asks for an administrator.
    nsis: {
        oneClick: true,
        perMachine: false,
        deleteAppDataOnUninstall: false,
    },

    // One installer for both architectures: it downloads the package of the computer it runs on from the release, which
    // the updater installs too, so it cannot be built without CLOWDY_RELEASE_REPO (`package:win` builds only the apps).
    // Named without the version, so `releases/latest/download/Clowdy-Setup.exe` always works.
    nsisWeb: {
        artifactName: '${productName}-Setup.${ext}',
    },
} satisfies Configuration;
