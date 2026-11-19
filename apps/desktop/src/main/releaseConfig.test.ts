import { describe, expect, test } from 'vitest';

import { releaseConfig } from './releaseConfig';

describe('releaseConfig', () => {
    test('a development run uses a test feed only when it names both the feed and its key', () => {
        const env = { CLOWDY_UPDATE_FEED: 'http://127.0.0.1:4789/', CLOWDY_UPDATE_PUBLIC_KEY: 'KEY' };

        expect(releaseConfig(false, env)).toEqual({ repo: '', signed: false, otaPublicKey: 'KEY', otaFeed: 'http://127.0.0.1:4789' });
        expect(releaseConfig(false, { CLOWDY_UPDATE_FEED: env.CLOWDY_UPDATE_FEED })).toMatchObject({ otaPublicKey: '', otaFeed: '' });
        expect(releaseConfig(false, { CLOWDY_UPDATE_PUBLIC_KEY: 'KEY' })).toMatchObject({ otaPublicKey: '', otaFeed: '' });
    });

    test('a packaged app ignores the test feed and, built without a release repository, has no updates', () => {
        expect(releaseConfig(true, { CLOWDY_UPDATE_FEED: 'http://127.0.0.1:4789', CLOWDY_UPDATE_PUBLIC_KEY: 'KEY' }))
            .toEqual({ repo: '', signed: false, otaPublicKey: '', otaFeed: '' });
    });
});
