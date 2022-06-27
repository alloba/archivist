/**
 * The entrypoint of the program exists to figure out which source and destinations are desired,
 * and initialize both.
 * The same commands are run regardless of source and destination, relying on method signatures defined
 * via shared interface.
 *
 */

import minimist from "minimist"

import FileSystemSource from "./mediasource/FileSystemSource.js";
import S3Source from "./mediasource/S3Source.js";
import FileSystemDestination from "./destination/FileSystemDestination.js";
import S3Destination from "./destination/S3Destination.js";

const LOG = console.log
LOG('-Beginning Archivist Operations-')

// region Init Arguments
const args = minimist(process.argv.slice(2)); //slice off executable path and file path
if (!args.source || !args.destination) {
    throw Error('Must provide runtime arguments for both `source` and `destination`.')
}
if (!args.source.type || !args.destination.type) {
    throw Error('Both source and destination must have a specified type (source.type/destination.type args).')
}
// endregion

// region Init Sources/Destination
const sourceMap = {'fs': FileSystemSource, 's3': S3Source}
const destinationMap = {'fs': FileSystemDestination, 's3': S3Destination}

const mediasourceKey = Object.keys(sourceMap).find(x => x == args.source.type)
const mediadestinationKey = Object.keys(destinationMap).find(x => x == args.destination.type)
if (mediasourceKey == undefined) {
    throw Error("Invalid Source Type")
}
if (mediadestinationKey == undefined) {
    throw Error("Invalid Destination Type")
}

const mediasource = new sourceMap[mediasourceKey as keyof typeof sourceMap](args.source)
const mediadestination = new destinationMap[mediadestinationKey as keyof typeof destinationMap](args.destination)
// endregion

// region Find Unique Files
const sourceMeta = await mediasource.scanForMetadata()
const destinationHashes = await mediadestination.getExistingMeta().then(x => x.map(z => z.md5))
const uniqueFromSource = sourceMeta.filter(x => !destinationHashes.includes(x.md5))

LOG(`Source - ${sourceMeta.length} items found`)
LOG(`Source - ${uniqueFromSource.length} items found not already in destination`)
// endregion

// region Save Files
await uniqueFromSource
    .map(x => ({meta: x, rawpromise: mediasource.downloadFile(x)}))
    .forEach(z => {
        LOG(`Saving ${z.meta.name} to destination...`)
        mediadestination.saveMedia(z.meta, z.rawpromise)
        LOG('Done')
    })
// endregion
LOG('-Concluded Archivist Operations-')


