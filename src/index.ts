/**
 * The entrypoint of the program exists to figure out which source and destination(s) are desired,
 * and initialize them. One or more destinations can be given (see DestinationArgs.ts).
 * The same commands are run regardless of source and destination, relying on method signatures defined
 * via shared interface.
 *
 */

import minimist from "minimist"

import FileSystemSource from "./mediasource/FileSystemSource.js";
import S3Source from "./mediasource/S3Source.js";
import FileSystemDestination from "./destination/FileSystemDestination.js";
import S3Destination from "./destination/S3Destination.js";
import {ChanSource} from "./mediasource/ChanSource.js";
import {archive} from "./archive.js";
import {parseDestinationArgs} from "./DestinationArgs.js";

console.log('-Beginning Archivist Operations-')

// region Init Arguments
// Dry run enabled by default. User has to explicitly mark operations via process args.
let serious = false
let ultraDry = false

const args = minimist(process.argv.slice(2)); //slice off executable path and file path
if (!args.source || !args.destination) {
    throw Error('Must provide runtime arguments for both `source` and `destination`.')
}
if (!args.source.type) {
    throw Error('Source must have a specified type (source.type arg).')
}

if(args.serious){
    serious = true
}
if(args.ultradry){
    ultraDry = true
}
// endregion

// region Init Sources/Destination
const sourceMap = {'fs': FileSystemSource, 's3': S3Source, '4chan': ChanSource}
const destinationMap = {'fs': FileSystemDestination, 's3': S3Destination}

const mediasourceKey = Object.keys(sourceMap).find(x => x == args.source.type)
if (mediasourceKey == undefined) {
    throw Error("Invalid Source Type")
}

// One or more destinations. See DestinationArgs.ts for the argument format.
const destinationArgList = parseDestinationArgs(args.destination)
const mediadestinations = destinationArgList.map(destinationargs => {
    if (!destinationargs.type) {
        throw Error('Every destination must have a specified type (destination.type args).')
    }
    const key = Object.keys(destinationMap).find(x => x == destinationargs.type)
    if (key == undefined) {
        throw Error("Invalid Destination Type")
    }
    return new destinationMap[key as keyof typeof destinationMap](destinationargs)
})

const mediasource = new sourceMap[mediasourceKey as keyof typeof sourceMap](args.source)
// endregion

// region Archive
if (ultraDry) {
    console.log('Terminating early due to Ultra Dry Run flag.')
    process.exit(0)
}

await archive(mediasource, mediadestinations, {serious})
// endregion

console.log('-Concluded Archivist Operations-')


