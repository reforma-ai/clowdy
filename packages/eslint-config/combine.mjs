/** Flatten flat-config fragments (arrays, promises, or single configs). */
export async function combine(...configs) {
    return (await Promise.all(configs)).flat();
}
