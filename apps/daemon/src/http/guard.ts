import { PROTOCOL_VERSION } from '@clowdy/protocol';
import { createHash, timingSafeEqual } from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ALLOWED_ORIGIN = /^(app:\/\/clowdy|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;

export const ALLOWED_HEADERS = 'Authorization, Content-Type, x-clowdy-protocol, Last-Event-ID';

/** DNS-rebinding guard: a request is served only when it was addressed to a loopback name. */
export function isLoopbackHost(host: string | null): boolean {
    if (!host) {
        return false;
    }

    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];

    return LOOPBACK_HOSTS.has(name.toLowerCase());
}

export function isAllowedOrigin(origin: string): boolean {
    return ALLOWED_ORIGIN.test(origin);
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
