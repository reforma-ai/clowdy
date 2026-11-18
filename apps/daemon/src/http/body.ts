/** The most a JSON route reads (`/v1/commands`). An upload has its own, larger limit: see `maxBody` of its route. */
export const JSON_BODY_LIMIT = 8 * 1024 * 1024;

/** A request body ran past the limit of the route that reads it. */
export class BodyTooLarge extends Error {
    constructor(readonly limit: number) {
        super(`The request body is over ${ limit } bytes`);
        this.name = 'BodyTooLarge';
    }
}

/** The length a client declared, 0 when it sent none or something that is not a number. */
export function declaredLength(request: Request): number {
    const length = Number(request.headers.get('content-length'));

    return Number.isFinite(length) && length > 0 ? length : 0;
}

/** The body as text, read in chunks so a body of unknown length (chunked) is refused at the limit too, not after it is all in memory. */
export async function readText(request: Request, limit: number): Promise<string> {
    const chunks: Uint8Array[] = [];
    let total = 0;

    if (request.body) {
        for await (const chunk of request.body) {
            total += chunk.length;

            if (total > limit) {
                throw new BodyTooLarge(limit);
            }

            chunks.push(chunk);
        }
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
}
