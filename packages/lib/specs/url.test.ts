import { describe, expect, it } from 'vitest';

import { isHttpUrl } from '../src/url';

describe('isHttpUrl', () => {
    it('should accept http and https absolute urls', () => {
        expect(isHttpUrl('https://mcp.figma.com/mcp')).toBe(true);
        expect(isHttpUrl('http://localhost:3000/mcp')).toBe(true);
    });

    it('should reject non-http schemes, relative paths, and junk', () => {
        expect(isHttpUrl('my custom server')).toBe(false);
        expect(isHttpUrl('/relative')).toBe(false);
        expect(isHttpUrl('ftp://example.com')).toBe(false);
        expect(isHttpUrl('')).toBe(false);
        expect(isHttpUrl('https://')).toBe(false);
    });
});
