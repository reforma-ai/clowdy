/**
 * The archive an OTA bundle travels in: a ustar tar (POSIX.1-1988) of regular files, gzipped by the caller. Written by
 * the release scripts and read by the app, which checks every file against the signed manifest afterwards, so the
 * reader only has to be strict about the format, not trust its contents.
 */
const BLOCK = 512;

export interface TarEntry {
    /** `/`-separated, relative. */
    path: string;
    data: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeString(header: Uint8Array, offset: number, length: number, value: string): void {
    const bytes = encoder.encode(value);

    if (bytes.length > length) throw new Error(`"${ value }" does not fit a tar header field of ${ length } bytes`);

    header.set(bytes, offset);
}

/** An octal number, zero-padded, ending in NUL. */
function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
    writeString(header, offset, length, `${ value.toString(8).padStart(length - 1, '0') }\0`);
}

/** ustar splits a path longer than 100 bytes at a `/` into a prefix of up to 155 bytes and a name of up to 100. */
function splitPath(file: string): { name: string; prefix: string } {
    if (encoder.encode(file).length <= 100) return { name: file, prefix: '' };

    for (let cut = file.indexOf('/'); cut !== -1; cut = file.indexOf('/', cut + 1)) {
        const prefix = file.slice(0, cut);
        const name = file.slice(cut + 1);

        if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) return { name, prefix };
    }

    throw new Error(`${ file } is too long for a ustar archive`);
}

function header(entry: TarEntry): Uint8Array {
    const block = new Uint8Array(BLOCK);
    const { name, prefix } = splitPath(entry.path);

    writeString(block, 0, 100, name);
    writeOctal(block, 100, 8, 0o644);
    writeOctal(block, 108, 8, 0);
    writeOctal(block, 116, 8, 0);
    writeOctal(block, 124, 12, entry.data.length);
    // A fixed time keeps the archive the same for the same files.
    writeOctal(block, 136, 12, 0);
    block[156] = '0'.charCodeAt(0);
    writeString(block, 257, 6, 'ustar\0');
    writeString(block, 263, 2, '00');
    writeString(block, 345, 155, prefix);
    // The checksum is computed with its own field as spaces.
    block.fill(0x20, 148, 156);
    writeString(block, 148, 8, `${ block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') }\0 `);

    return block;
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

/** The entries as one tar, in the order given. */
export function writeTar(entries: readonly TarEntry[]): Uint8Array {
    const size = entries.reduce((sum, { data }) => sum + BLOCK + data.length + padding(data.length), 0) + 2 * BLOCK;
    const out = new Uint8Array(size);
    let offset = 0;

    for (const entry of entries) {
        out.set(header(entry), offset);
        out.set(entry.data, offset + BLOCK);
        offset += BLOCK + entry.data.length + padding(entry.data.length);
    }

    return out;
}

function readString(block: Uint8Array, offset: number, length: number): string {
    const field = block.subarray(offset, offset + length);
    const end = field.indexOf(0);

    return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
    const text = readString(block, offset, length).trim();

    if (!/^[0-7]+$/.test(text)) throw new Error('A tar header has a malformed number');

    return Number.parseInt(text, 8);
}

/**
 * The regular files of a tar. Folders are skipped (paths imply them); links and every other kind of entry are refused,
 * as is a header whose checksum does not match or a body that runs past the end.
 */
export function readTar(bytes: Uint8Array): TarEntry[] {
    const entries: TarEntry[] = [];

    for (let offset = 0; offset + BLOCK <= bytes.length;) {
        const block = bytes.subarray(offset, offset + BLOCK);

        // The archive ends with zero blocks.
        if (block.every(byte => byte === 0)) return entries;

        const stored = readOctal(block, 148, 8);
        const actual = block.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte), 0);

        if (stored !== actual) throw new Error('A tar header fails its checksum');

        const type = String.fromCharCode(block[156]!);
        const size = readOctal(block, 124, 12);
        const prefix = readString(block, 345, 155);
        const name = readString(block, 0, 100);
        const start = offset + BLOCK;

        if (start + size > bytes.length) throw new Error(`${ name } runs past the end of the archive`);

        if (type === '0' || type === '\0') entries.push({ path: prefix ? `${ prefix }/${ name }` : name, data: bytes.slice(start, start + size) });
        else if (type !== '5') throw new Error(`${ name } is not a regular file or a folder`);

        offset = start + size + padding(size);
    }

    throw new Error('The archive ends without its end marker');
}
