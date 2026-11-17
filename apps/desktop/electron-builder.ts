import type { Configuration } from 'electron-builder';

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
    files: ['package.json', 'dist/**', 'renderer/**', '!node_modules/**'],

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
        entitlementsInherit: 'build/entitlements.mac.plist',
        notarize: false,
    },

    // Unsigned for now: SmartScreen names no publisher until the builds are signed.
    win: {
        icon: 'build/icon.png',
    },

    // For the installer, once releases build one: per user under %LOCALAPPDATA%\Programs, so it never asks for an administrator.
    nsis: {
        oneClick: true,
        perMachine: false,
        deleteAppDataOnUninstall: false,
    },
} satisfies Configuration;
