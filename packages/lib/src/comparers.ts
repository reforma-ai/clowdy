/**
 * Compares two arrays for identity, ignoring sorting
 *
 * @param {boolean} ignoreSorting
 * @param {Array} arrayOne
 * @param {Array} arrayTwo
 */
export const compareArray = (ignoreSorting: boolean, arrayOne: any[], arrayTwo: any[]) => {
    if (!Array.isArray(arrayOne) || !Array.isArray(arrayTwo) || arrayOne.length !== arrayTwo.length) {
        return false;
    }

    return arrayOne.every((value, index) => (ignoreSorting ? arrayTwo.includes(value) : arrayTwo[index] === value));
};

/**
 * Compares two objects for identity by keys (and values optionally)
 *
 * @param  {object} objectOne - First object to compare
 * @param  {object} objectTwo - Second object to compare
 */
export const equalObjects = (objectOne: any, objectTwo: any) => {
    // Just equal
    if (objectOne === objectTwo) {
        return true;
    }

    // Both are objects and not null
    if (typeof objectOne == 'object' && objectOne != null && typeof objectTwo == 'object' && objectTwo != null) {
        // Same keys count
        if (Object.keys(objectOne).length !== Object.keys(objectTwo).length) {
            return false;
        }

        // Keys comparison
        for (const prop of Object.keys(objectOne)) {
            if (Object.prototype.hasOwnProperty.call(objectTwo, prop)) {
                // Recursive check
                if (typeof objectOne[prop] === 'object') {
                    if (!equalObjects(objectOne[prop], objectTwo[prop])) {
                        return false;
                    }
                }
                // Values comparsion
                else if (objectOne[prop] !== objectTwo[prop]) {
                    return false;
                }
            } else {
                return false;
            }
        }

        return true;
    }

    return false;
};
