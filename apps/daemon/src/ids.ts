const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_BITS = 80n;
const RANDOM_MASK = (1n << RANDOM_BITS) - 1n;

export type IdPrefix = 'prj' | 'cht' | 'tsk' | 'run' | 'itm' | 'sts' | 'qst' | 'art' | 'att' | 'que' | 'fld' | 'cmt' | 'trm' | 'apv';

let lastTime = 0;
let lastRandom = 0n;

function encode(value: bigint, length: number): string {
    let result = '';

    for (let index = 0; index < length; index++) {
        result = ALPHABET[Number(value & 31n)] + result;
        value >>= 5n;
    }

    return result;
}

function randomBits(): bigint {
    const bytes = crypto.getRandomValues(new Uint8Array(10));

    return bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}

/**
 * `prefix_` plus a 26 character Crockford base32 ULID: 48 bits of milliseconds, then 80 random bits.
 * Ids sort by creation time, also within one millisecond (the random part counts up).
 */
export function newId(prefix: IdPrefix): string {
    const now = Math.max(Date.now(), lastTime);

    if (now === lastTime) {
        lastRandom = (lastRandom + 1n) & RANDOM_MASK;
    }
    else {
        lastTime = now;
        lastRandom = randomBits();
    }

    return `${ prefix }_${ encode(BigInt(lastTime), 10) }${ encode(lastRandom, 16) }`;
}
