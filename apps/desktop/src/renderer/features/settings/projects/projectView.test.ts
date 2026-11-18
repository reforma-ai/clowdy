import { describe, expect, it } from 'vitest';

import { holdingsLine, remoteLink, removalMessage } from './projectView';

describe('remoteLink', () => {
    it.each([
        ['git@github.com:acme/app.git', { text: 'github.com/acme/app', href: 'https://github.com/acme/app' }],
        ['github.com:acme/app', { text: 'github.com/acme/app', href: 'https://github.com/acme/app' }],
        ['https://github.com/acme/app.git', { text: 'github.com/acme/app', href: 'https://github.com/acme/app' }],
        ['https://github.com/acme/app/', { text: 'github.com/acme/app', href: 'https://github.com/acme/app' }],
        ['ssh://git@gitlab.example.com:2222/team/sub/app.git', { text: 'gitlab.example.com/team/sub/app', href: 'https://gitlab.example.com/team/sub/app' }],
        ['https://git.example.com:8443/acme/app.git', { text: 'git.example.com:8443/acme/app', href: 'https://git.example.com:8443/acme/app' }],
    ])('links %s', (remote, expected) => {
        expect(remoteLink(remote)).toEqual(expected);
    });

    it('drops credentials from the text and the link', () => {
        expect(remoteLink('https://octocat:ghp_secret@github.com/acme/app.git')).toEqual({ text: 'github.com/acme/app', href: 'https://github.com/acme/app' });
        expect(remoteLink('http://octocat:secret@intranet.example.com/acme/app.git')).toEqual({ text: 'http://intranet.example.com/acme/app.git' });
    });

    it('drops credentials from an address that does not parse too', () => {
        expect(remoteLink('https://octocat:ghp_secret@github.com:abc/acme/app.git')).toEqual({ text: 'https://github.com:abc/acme/app.git' });
        expect(remoteLink('ssh://deploy:hunter2@build host/acme/app.git')?.text).not.toContain('hunter2');
        expect(remoteLink('https://octocat:ghp_secret@github.com:abc/acme/app.git')?.href).toBeUndefined();
    });

    it.each([
        ['/Users/me/repos/app.git'],
        ['C:\\repos\\app.git'],
        ['file:///srv/git/app.git'],
        ['git@intranet:acme/app.git'],
    ])('shows %s without a link', (remote) => {
        expect(remoteLink(remote)?.href).toBeUndefined();
    });

    it('has nothing to show for an empty remote', () => {
        expect(remoteLink(undefined)).toBeUndefined();
        expect(remoteLink('  ')).toBeUndefined();
    });
});

describe('holdingsLine', () => {
    it('counts chats and tasks, with the right plural', () => {
        expect(holdingsLine({ chats: 12, tasks: 5 })).toBe('12 chats · 5 tasks');
        expect(holdingsLine({ chats: 1, tasks: 1 })).toBe('1 chat · 1 task');
        expect(holdingsLine({ chats: 0, tasks: 0 })).toBe('No chats or tasks yet');
        expect(holdingsLine(undefined)).toBeUndefined();
    });
});

describe('removalMessage', () => {
    it('says what goes and what stays', () => {
        expect(removalMessage('Car Rental', '/Users/dev/car-rental', { chats: 4, tasks: 11 })).toBe(
            '"Car Rental" leaves Clowdy together with its 4 chats and 11 tasks, and the work of its agents, for good. The folder /Users/dev/car-rental and everything in it stay on your computer.'
        );
        expect(removalMessage('Car Rental', '/x', undefined)).toContain('its chats and tasks, and the work');
    });
});
