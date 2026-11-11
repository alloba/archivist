import {SourceInterface} from "./mediasource/SourceInterface.js";
import {DestinationInterface} from "./destination/DestinationInterface.js";
import FileMeta from "./model/FileMeta.js";
import FileUtils from "./FileUtils.js";

/**
 * Core of a run: figure out what each destination is missing, then fetch each needed file once from the source
 * and hand it to every destination that needs it.
 *
 * Uniqueness is decided per destination, so destinations that have drifted apart will each catch up independently.
 *
 * Failure handling:
 * - Any failure while reading existing state (scan phase) aborts the run before anything is saved anywhere.
 * - A failure while saving does not stop the remaining files or destinations (so data is not lost from the healthy
 *   destinations), but the run throws at the end, so it is reported as a failure.
 */
export async function archive(
    source: SourceInterface,
    destinations: DestinationInterface[],
    options: { serious: boolean }
): Promise<{ saveAttempts: number }> {
    const errors: Error[] = []
    let saveAttempts = 0
    try {
        const sourceMeta = await source.scanForMetadata()

        const needed: Set<FileMeta>[] = []
        for (const destination of destinations) {
            const existing = new Set((await destination.getExistingMeta()).map(x => x.md5))
            const unique = sourceMeta.filter(x => !existing.has(x.md5))
            needed.push(new Set(unique))
            console.log(`Source - ${sourceMeta.length} items found, ${unique.length} of which are unique to destination ${needed.length}.`)
        }

        if (!options.serious) {
            console.log('Terminating early due to lack of serious flag.')
            return {saveAttempts}
        }

        const targets = sourceMeta.filter(x => needed.some(set => set.has(x)))
        const downloads = new Map<FileMeta, Promise<Buffer>>(targets.map(x => [x, source.downloadFile(x)]))
        downloads.forEach(p => p.catch(() => undefined)) // failures are surfaced below, where the promise is awaited

        for (let i = 0; i < targets.length; i++) {
            console.log(`${i + 1}/${targets.length} - ${targets[i].name}`)
            // One name for the file, shared by every destination, so the destinations stay identical to each other.
            const filename = FileUtils.getUniqueName(targets[i].name)
            for (let d = 0; d < destinations.length; d++) {
                if (!needed[d].has(targets[i])) {
                    continue
                }
                saveAttempts++
                try {
                    await destinations[d].saveMedia(targets[i], downloads.get(targets[i])!, filename)
                } catch (e) {
                    console.error(`Failed saving ${targets[i].name} to destination ${d + 1} :: ${e}`)
                    errors.push(e instanceof Error ? e : Error(String(e)))
                }
            }
        }
    } finally {
        for (const destination of destinations) {
            try {
                await destination.close?.()
            } catch (e) {
                console.error(`Failed closing destination :: ${e}`)
                errors.push(e instanceof Error ? e : Error(String(e)))
            }
        }
    }

    if (errors.length > 0) {
        throw Error(`${errors.length} error(s) occurred while saving. First error: ${errors[0].message}`)
    }
    return {saveAttempts}
}
