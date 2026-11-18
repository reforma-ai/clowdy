/** Kinds a page may show in an `<img>`. The daemon serves every file as it is, so only these are taken for pictures; anything else shows as its file icon. */
const PICTURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml']);

export const isPicture = (mediaType: string): boolean => PICTURES.has(mediaType);
