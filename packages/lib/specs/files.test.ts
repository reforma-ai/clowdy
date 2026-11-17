import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createObjectURL,
    extensionForMediaType,
    filesFromDataTransfer,
    formatFileSize,
    mediaTypeForExtension,
    revokeObjectURL,
} from '../src/files';

describe('formatFileSize', () => {
    it('formats bytes, kilobytes, and megabytes', () => {
        expect(formatFileSize(0)).toBe('0 B');
        expect(formatFileSize(512)).toBe('512 B');
        expect(formatFileSize(1024)).toBe('1 KB');
        expect(formatFileSize(1536)).toBe('2 KB');
        expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
        expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    });

    it('formats limit-style sizes with round: up', () => {
        expect(formatFileSize(0, { round: 'up' })).toBe('0 B');
        expect(formatFileSize(1, { round: 'up' })).toBe('1 KB');
        expect(formatFileSize(1025, { round: 'up' })).toBe('2 KB');
        expect(formatFileSize(20 * 1024 * 1024, { round: 'up' })).toBe('20 MB');
        expect(formatFileSize(1.5 * 1024 * 1024, { round: 'up' })).toBe('1.5 MB');
    });
});

describe('extensionForMediaType / mediaTypeForExtension', () => {
    it('maps image media types to extensions', () => {
        expect(extensionForMediaType('image/jpeg')).toBe('jpg');
        expect(extensionForMediaType('image/png')).toBe('png');
        expect(extensionForMediaType('image/webp')).toBe('webp');
        expect(extensionForMediaType('image/gif')).toBe('gif');
        expect(extensionForMediaType('unknown')).toBe('png');
    });

    it('maps extensions back to media types', () => {
        expect(mediaTypeForExtension('jpg')).toBe('image/jpeg');
        expect(mediaTypeForExtension('.PNG')).toBe('image/png');
        expect(mediaTypeForExtension('bin')).toBeUndefined();
    });
});

describe('filesFromDataTransfer', () => {
    it('returns files from dataTransfer.files', () => {
        const file = { name: 'shot.png' } as File;
        const dt = {
            files: [file],
            items: [],
        } as unknown as DataTransfer;

        expect(filesFromDataTransfer(dt)).toEqual([file]);
    });

    it('falls back to items when files is empty', () => {
        const file = { name: 'shot.png' } as File;
        const dt = {
            files: { length: 0 },
            items: [{ kind: 'file', getAsFile: () => file }],
        } as unknown as DataTransfer;

        expect(filesFromDataTransfer(dt)).toEqual([file]);
    });

    it('returns an empty array for text-only payloads', () => {
        const dt = {
            files: { length: 0 },
            items: [{ kind: 'string', getAsFile: () => null }],
        } as unknown as DataTransfer;

        expect(filesFromDataTransfer(dt)).toEqual([]);
    });
});

describe('createObjectURL / revokeObjectURL', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('creates and revokes blob URLs', () => {
        const create = vi.fn(() => 'blob:test');
        const revoke = vi.fn();

        vi.stubGlobal('URL', {
            createObjectURL: create,
            revokeObjectURL: revoke,
        });

        const blob = new Blob(['x']);

        expect(createObjectURL(blob)).toBe('blob:test');
        expect(create).toHaveBeenCalledWith(blob);

        revokeObjectURL('blob:test');
        expect(revoke).toHaveBeenCalledWith('blob:test');
    });

    it('ignores non-blob URLs on revoke', () => {
        const revoke = vi.fn();

        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(),
            revokeObjectURL: revoke,
        });

        revokeObjectURL('https://cdn.example/file.png');
        expect(revoke).not.toHaveBeenCalled();
    });
});
