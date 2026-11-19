/** The side of the square a project's icon is drawn into: sharp at the 16 to 20px it is shown at, on a screen of twice the density. */
const ICON_SIDE = 64;

/** The largest picture the app takes to make an icon of. */
export const MAX_ICON_SOURCE_BYTES = 5 * 1024 * 1024;

/**
 * The picture as a project's icon: drawn whole into an `ICON_SIDE` square, centred, with a clear background where it is not square, as a
 * PNG data URL. Any picture Chromium can show works, an SVG or an `.ico` too, and an SVG is a drawing on a canvas after this, never shown
 * as itself. Rejects a file that is not a picture it can read.
 */
export async function squareIcon(file: Blob): Promise<string> {
    const url = URL.createObjectURL(file);

    try {
        const image = new Image();

        image.src = url;
        await image.decode();

        const canvas = document.createElement('canvas');

        canvas.width = ICON_SIDE;
        canvas.height = ICON_SIDE;

        const context = canvas.getContext('2d');

        if (!context) throw new Error('The picture cannot be drawn');

        // Chromium sizes an SVG without width and height by its viewBox (150px on the short side), and one without either 300 by 150; a
        // picture that still reports no size is drawn as a square rather than divided by zero.
        const width = image.naturalWidth || ICON_SIDE;
        const height = image.naturalHeight || ICON_SIDE;
        const scale = Math.min(ICON_SIDE / width, ICON_SIDE / height);
        const drawnWidth = width * scale;
        const drawnHeight = height * scale;

        context.imageSmoothingQuality = 'high';
        context.drawImage(image, (ICON_SIDE - drawnWidth) / 2, (ICON_SIDE - drawnHeight) / 2, drawnWidth, drawnHeight);

        return canvas.toDataURL('image/png');
    }
    finally {
        URL.revokeObjectURL(url);
    }
}
