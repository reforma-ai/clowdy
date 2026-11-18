import { PROTOCOL_VERSION } from '@clowdy/protocol';
import { createHash, timingSafeEqual } from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** The app's own origin, which the desktop shell serves its files from. Anything else must be named in `CLOWDY_CORS_ORIGINS`. */
const APP_ORIGIN = 'app://clowdy';

export const ALLOWED_HEADERS = 'Authorization, Content-Type, x-clowdy-protocol, Last-Event-ID';

/** DNS-rebinding guard: a request is served only when it was addressed to a loopback name. */
export function isLoopbackHost(host: string | null): boolean {
    if (!host) {
        return false;
    }

    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];

    return LOOPBACK_HOSTS.has(name.toLowerCase());
}

/** The app's origin always; any other only when it is listed exactly (a tool's dev server, say). */
export function isAllowedOrigin(origin: string, extra: readonly string[] = []): boolean {
    return origin === APP_ORIGIN || extra.includes(origin);
}

/** Compares in constant time regardless of where the strings differ. */
export function tokenMatches(authorization: string | null, token: string): boolean {
    const match = /^Bearer (.+)$/i.exec(authorization ?? '');

    if (!match) {
        return false;
    }

    const digest = (value: string) => createHash('sha256').update(value).digest();

    return timingSafeEqual(digest(match[1]), digest(token));
}

/** A client that names another protocol major is refused; one that names none is accepted. */
export function protocolMismatch(header: string | null): boolean {
    return header !== null && Number.parseInt(header, 10) !== PROTOCOL_VERSION;
}
