import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';
import { TransportError, type Transport } from './transport';

export type DaemonConfig =
    | { kind: 'daemon'; url: string; token: string }
    | { kind: 'fixtures'; timeline: boolean }
    | { kind: 'none' };

/**
 * Where the UI gets its data, in order of precedence:
 * 1. `window.desktop.daemon`, which the desktop shell fills in;
 * 2. `?daemon=<url>&token=<token>` in the page URL;
 * 3. `?fixtures`, scripted data in memory (`?fixtures=static` leaves out the timed events);
 * 4. nothing: the UI shows that it cannot reach a daemon.
 */
export function resolveDaemonConfig(search: string, bridge?: { url: string; token: string }): DaemonConfig {
    if (bridge) return { kind: 'daemon', ...bridge };

    const params = new URLSearchParams(search);
    const url = params.get('daemon');

    if (url) return { kind: 'daemon', url, token: params.get('token') ?? '' };

    if (params.has('fixtures')) return { kind: 'fixtures', timeline: params.get('fixtures') !== 'static' };

    return { kind: 'none' };
}

const noDaemon = () => Promise.reject(new TransportError('No daemon is configured'));

/** Answers every request with a failure, so the UI shows its "cannot reach" screen like for any unreachable daemon. */
const unconfigured: Transport = {
    getRootSnapshot: noDaemon,
    getProjectSnapshot: noDaemon,
    subscribe: () => () => undefined,
    command: noDaemon,
    getItems: noDaemon,
    getTaskDetail: noDaemon,
    getDocsTree: noDaemon,
    getDocFile: noDaemon,
    getProjectFiles: noDaemon,
    uploadAttachment: noDaemon,
    getAttachment: noDaemon,
    deleteAttachment: noDaemon,
    getSkills: noDaemon,
};

export function createTransport(config: DaemonConfig): Transport {
    if (config.kind === 'daemon') return new HttpTransport(config);

    return config.kind === 'fixtures' ? new FixtureTransport({ timeline: config.timeline }) : unconfigured;
}
