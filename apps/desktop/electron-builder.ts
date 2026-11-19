import type { Configuration, FileSet } from 'electron-builder';

/**
 * What the daemon needs outside the ASAR, where Bun can read and run it (`scripts/build.ts`): the daemon and the system
 * skills of the app's own bundle, and the Bun for the arch being packaged. The app copies both out of the install folder
 * before it starts the daemon (`src/main/bundle.ts`). Named per platform here: `${platform}` would expand to the build host's.
 */
function daemonResources(platform: 'darwin' | 'win32'): FileSet[] {
    return [
        { from: 'bundle', to: 'bundle' },
        // electron-builder expands `${arch}`, not TypeScript.
        { from: `runtime/${ platform }-\${arch}`, to: 'bun' },
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
    files: ['package.json', 'bundle.json', 'dist/**', 'renderer/**', '!node_modules/**'],

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

    // `bun run package` and `package:win` build unpacked apps (`--dir`); installers, signing, and notarization
    // come with releases. Signing needs an Apple Developer ID; until there is one, `package` signs ad hoc.
    mac: {
        category: 'public.app-category.developer-tools',
        icon: 'build/icon.png',
        hardenedRuntime: true,
        entitlements: 'build/entitlements.mac.plist',
        // Every other Mach-O in the bundle, Bun included, is signed with these.
        entitlementsInherit: 'build/entitlements.mac.inherit.plist',
        notarize: false,
        extraResources: daemonResources('darwin'),
    },

    // Unsigned for now: SmartScreen names no publisher until the builds are signed.
    win: {
        icon: 'build/icon.png',
        extraResources: daemonResources('win32'),
    },

    // For the installer, once releases build one: per user under %LOCALAPPDATA%\Programs, so it never asks for an administrator.
    nsis: {
        oneClick: true,
        perMachine: false,
        deleteAppDataOnUninstall: false,
    },
} satisfies Configuration;
