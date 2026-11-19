import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpdater, type Ask, type ShellUpdater } from './updater';

const HOUR = 60 * 60_000;

class FakeUpdater implements ShellUpdater {
    autoDownload = true;
    /** The version the feed offers, or null when the app is current. */
    latest: string | null = null;
    failingDownloads = 0;
    /** What Squirrel.Mac says after each download: it accepts unless told to refuse. */
    squirrelRefusals = 0;
    checks = 0;
    downloads = 0;
    quitAndInstall = vi.fn();
    /** Electron's `autoUpdater`. */
    squirrel = new EventEmitter();

    async checkForUpdates() {
        this.checks += 1;

        return { isUpdateAvailable: this.latest !== null, updateInfo: { version: this.latest ?? '0.1.0' } };
    }

    async downloadUpdate() {
        this.downloads += 1;

        if (this.failingDownloads > 0) {
            this.failingDownloads -= 1;

            throw new Error('sha512 checksum mismatch');
        }

        // Squirrel.Mac fetches the zip, then unzips it and checks its signature.
        void Promise.resolve().then(() => {
            if (this.squirrelRefusals > 0) {
                this.squirrelRefusals -= 1;
                this.squirrel.emit('error', new Error('code signature mismatch'));
            }
            else {
                this.squirrel.emit('update-downloaded');
            }
        });
    }
}

function launch({ platform = 'darwin' as NodeJS.Platform, inApplications = true, selfUpdates = true, latest = null as string | null, answers = [] as boolean[] } = {}) {
    const updater = new FakeUpdater();

    // Set before the start: a build that cannot update itself checks without waiting for anything first.
    updater.latest = latest;
    const app = { isInApplicationsFolder: vi.fn(() => inApplications), moveToApplicationsFolder: vi.fn(() => true) };
    const ask = vi.fn<Ask>(async () => answers.shift() ?? false);
    const openReleasePage = vi.fn();
    const shell = createUpdater({ updater, squirrel: updater.squirrel, platform, selfUpdates, app, ask, openReleasePage });
    const started = shell.start();

    return { updater, app, ask, openReleasePage, shell, started };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('createUpdater', () => {
    test('checks at launch and hourly, downloading only when it decides to', async () => {
        const { updater, started } = launch();

        await started;

        expect(updater.autoDownload).toBe(false);
        expect(updater.checks).toBe(1);

        await vi.advanceTimersByTimeAsync(2 * HOUR);

        expect(updater.checks).toBe(3);
    });

    test('downloads a newer shell, offers a restart, and installs when the person accepts', async () => {
        const { updater, ask, started } = launch({ answers: [true] });

        updater.latest = '0.2.0';
        await started;

        expect(ask).toHaveBeenCalledOnce();
        expect(ask.mock.calls[0][0].message).toContain('0.2.0');
        expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    });

    test('leaves a declined update to install on quit, and neither checks nor asks again', async () => {
        const { updater, ask, started } = launch({ answers: [false] });

        updater.latest = '0.2.0';
        await started;
        await vi.advanceTimersByTimeAsync(3 * HOUR);

        expect(updater.quitAndInstall).not.toHaveBeenCalled();
        expect(updater.checks).toBe(1);
        expect(ask).toHaveBeenCalledOnce();
    });

    test('keeps running after a failed download and retries at the next check', async () => {
        const { updater, ask, started } = launch({ answers: [true] });

        updater.latest = '0.2.0';
        updater.failingDownloads = 1;
        await expect(started).resolves.toBeUndefined();

        expect(ask).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(HOUR);

        expect(ask).toHaveBeenCalledOnce();
        expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    });

    test('retries an update Squirrel.Mac refuses at the next check, without asking before', async () => {
        const { updater, ask, started } = launch({ answers: [true] });

        updater.latest = '0.2.0';
        updater.squirrelRefusals = 1;
        await expect(started).resolves.toBeUndefined();

        expect(ask).not.toHaveBeenCalled();
        expect(updater.squirrel.listenerCount('error')).toBe(0);

        await vi.advanceTimersByTimeAsync(HOUR);

        expect(ask).toHaveBeenCalledOnce();
        expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    });

    test.each([
        ['moves the app when the person accepts', [true], 1],
        ['stays put when the person declines', [false], 0],
    ])('outside Applications offers the move, never updates from there, and %s', async (_name, answers, moves) => {
        const { updater, app, ask, started } = launch({ inApplications: false, answers });

        await started;
        await vi.advanceTimersByTimeAsync(2 * HOUR);

        expect(ask).toHaveBeenCalledOnce();
        expect(app.moveToApplicationsFolder).toHaveBeenCalledTimes(moves);
        expect(updater.checks).toBe(0);
    });

    test('keeps running when the move fails', async () => {
        const { app, started } = launch({ inApplications: false, answers: [true] });

        app.moveToApplicationsFolder.mockImplementation(() => {
            throw new Error('The move was cancelled');
        });

        await expect(started).resolves.toBeUndefined();
    });

    test('does not ask about the install location on Windows', async () => {
        const { updater, app, ask, started } = launch({ platform: 'win32', inApplications: false });

        await started;

        expect(app.isInApplicationsFolder).not.toHaveBeenCalled();
        expect(ask).not.toHaveBeenCalled();
        expect(updater.checks).toBe(1);
    });

    test('a build that cannot update itself offers the release page once per version, and never downloads', async () => {
        const { updater, ask, openReleasePage, shell, started } = launch({ selfUpdates: false, inApplications: false, latest: '0.2.0', answers: [true, false, true] });

        await started;

        expect(ask).toHaveBeenCalledOnce();
        expect(ask.mock.calls[0][0].accept).toBe('Download');
        expect(openReleasePage).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(2 * HOUR);

        expect(updater.checks).toBe(3);
        expect(ask).toHaveBeenCalledOnce();

        // Asked by the person, it offers the page again.
        await expect(shell.checkNow(() => undefined)).resolves.toBe('0.2.0');
        expect(ask).toHaveBeenCalledTimes(2);

        updater.latest = '0.3.0';
        await vi.advanceTimersByTimeAsync(HOUR);

        expect(ask).toHaveBeenCalledTimes(3);
        expect(openReleasePage).toHaveBeenCalledTimes(2);
        expect(updater.downloads).toBe(0);
        expect(updater.quitAndInstall).not.toHaveBeenCalled();
    });

    test('checks when asked, and reports a current shell or a newer one after its sheet', async () => {
        const { updater, ask, shell, started } = launch({ answers: [false] });
        const found = vi.fn();

        await started;

        await expect(shell.checkNow(found)).resolves.toBeNull();

        updater.latest = '0.2.0';

        await expect(shell.checkNow(found)).resolves.toBe('0.2.0');
        expect(found).toHaveBeenCalledExactlyOnceWith('0.2.0');
        expect(ask).toHaveBeenCalledOnce();
        expect(updater.checks).toBe(3);
    });

    test('offers a put-off update again when asked, without another check or download', async () => {
        const { updater, ask, shell, started } = launch({ answers: [false, true] });
        const found = vi.fn();

        updater.latest = '0.2.0';
        await started;

        await expect(shell.checkNow(found)).resolves.toBe('0.2.0');
        expect(found).not.toHaveBeenCalled();
        expect(updater.checks).toBe(1);
        expect(ask).toHaveBeenCalledTimes(2);
        expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    });

    test('rejects a check the person asked for when the download fails', async () => {
        const { updater, ask, shell, started } = launch();

        await started;
        updater.latest = '0.2.0';
        updater.failingDownloads = 1;

        await expect(shell.checkNow(() => undefined)).rejects.toThrow('sha512');
        expect(ask).not.toHaveBeenCalled();
    });

    test('refuses a check the person asked for outside Applications', async () => {
        const { updater, shell, started } = launch({ inApplications: false });

        await started;

        await expect(shell.checkNow(() => undefined)).rejects.toThrow('Applications');
        expect(updater.checks).toBe(0);
    });
});
