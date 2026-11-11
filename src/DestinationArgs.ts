/**
 * Normalizes the parsed `destination` runtime argument into a list of per-destination argument objects.
 *
 * Single destination (original form):
 *     --destination.type s3 --destination.bucket foo ...
 * Multiple destinations (indexed form, args for each are kept separate):
 *     --destination.0.type s3 --destination.0.bucket foo --destination.1.type fs --destination.1.path ./out
 */
export function parseDestinationArgs(destination: any): any[] {
    if (!destination || typeof destination !== 'object') {
        throw Error('Must provide runtime arguments for `destination`.')
    }

    const keys = Object.keys(destination)
    const indexedKeys = keys.filter(k => /^\d+$/.test(k))
    if (indexedKeys.length === 0) {
        return [destination]
    }
    if (indexedKeys.length !== keys.length) {
        throw Error('Cannot mix indexed (destination.0.type) and non-indexed (destination.type) destination arguments.')
    }

    return indexedKeys
        .sort((a, b) => Number(a) - Number(b))
        .map(k => destination[k])
}
