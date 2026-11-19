import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const figmaSettingsUrl = 'https://www.figma.com/settings';
const authRequiredMessage =
    'Figma authorization is required. ' +
    'Run ./clowdy sync icons auth in an interactive terminal. ' +
    'Do not send the access token through chat.';

class FigmaAuthError extends Error {
    constructor(message) {
        super(message);
        this.code = 'AUTH_REQUIRED';
        this.name = 'FigmaAuthError';
    }
}

// The token is a personal access token of the Figma account, not of a project, so Clowdy reads the
// same file the Reforma repository writes: authorize in either one and both can sync.
function getTokenFile() {
    return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        'reforma',
        'figma-access-token'
    );
}

function openBrowser(url) {
    const command =
        process.platform === 'darwin'
            ? ['open', [url]]
            : process.platform === 'win32'
              ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
              : ['xdg-open', [url]];
    const child = spawn(command[0], command[1], {
        detached: true,
        stdio: 'ignore',
    });

    child.on('error', () => {
        // The settings URL is also printed for manual opening.
    });
    child.unref();
}

async function readStoredToken() {
    const tokenFile = getTokenFile();

    try {
        return (await fs.readFile(tokenFile, 'utf8')).trim() || null;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    }
}

async function writeStoredToken(token) {
    const tokenFile = getTokenFile();
    const directory = path.dirname(tokenFile);
    const temporaryFile = `${tokenFile}.${process.pid}.tmp`;

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);

    try {
        await fs.writeFile(temporaryFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporaryFile, tokenFile);
        await fs.chmod(tokenFile, 0o600);
    } finally {
        await fs.rm(temporaryFile, { force: true });
    }
}

async function clearStoredFigmaToken() {
    await fs.rm(getTokenFile(), { force: true });
}

async function promptHidden(prompt, output) {
    const wasRaw = process.stdin.isRaw;

    output.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();

    return new Promise((resolve, reject) => {
        let value = '';
        let onData;
        let onError;

        const cleanup = () => {
            process.stdin.off('data', onData);
            process.stdin.off('error', onError);
            process.stdin.setRawMode(wasRaw);
            process.stdin.pause();
        };
        const finish = () => {
            cleanup();
            output.write('\n');
            resolve(value.trim());
        };
        onError = error => {
            cleanup();
            output.write('\n');
            reject(error);
        };
        onData = data => {
            for (const character of data) {
                if (character === '\u0003') {
                    cleanup();
                    output.write('\n');
                    reject(new Error('Figma authorization cancelled.'));

                    return;
                }

                if (character === '\r' || character === '\n') {
                    finish();

                    return;
                }

                if (character === '\u007f' || character === '\b') {
                    value = value.slice(0, -1);
                } else if (character >= ' ') {
                    value += character;
                }
            }
        };

        process.stdin.on('data', onData);
        process.stdin.on('error', onError);
    });
}

function canPrompt(output) {
    return Boolean(process.stdin.isTTY && output.isTTY && process.stdin.setRawMode);
}

async function requestPersonalAccessToken(output) {
    output.write(
        `${[
            'Figma authorization is required.',
            '',
            '1. In the opened Figma settings, select Security.',
            '2. Under Personal access tokens, click Generate new token.',
            '3. Set Name.',
            '4. Set Expiration to 90 days.',
            '5. Under Scopes, select Files → file_content:read.',
            '6. Generate and copy the token.',
            '',
            `Figma settings: ${figmaSettingsUrl}`,
        ].join('\n')}\n`
    );
    openBrowser(figmaSettingsUrl);

    const token = await promptHidden('Paste the token (input is hidden): ', output);

    if (token.length < 20 || /\s/.test(token)) {
        throw new Error('The Figma personal access token is invalid.');
    }

    await writeStoredToken(token);

    return token;
}

export async function getFigmaAuthHeaders({ force = false, output = process.stdout } = {}) {
    if (process.env.FIGMA_ACCESS_TOKEN) {
        return { 'X-Figma-Token': process.env.FIGMA_ACCESS_TOKEN };
    }

    if (force && !canPrompt(output)) {
        throw new FigmaAuthError(authRequiredMessage);
    }

    if (force) {
        await clearStoredFigmaToken();
    }

    const storedToken = await readStoredToken();

    if (storedToken) {
        return { 'X-Figma-Token': storedToken };
    }

    if (!canPrompt(output)) {
        throw new FigmaAuthError(authRequiredMessage);
    }

    const token = await requestPersonalAccessToken(output);

    return { 'X-Figma-Token': token };
}
