/**
 * The entrypoint of the program exists to figure out which source and destinations are desired,
 * and initialize both.
 * The same commands are run regardless of source and destination, relying on method signatures defined
 * via shared interface.
 *
 */

import minimist from "minimist"
import fs from 'fs'
import path from 'path'
import {ArchivistParameters} from "./ArchivistParameters";

const LOG = console.log

LOG('-Beginning Archivist Operations-')
const args = minimist(process.argv.slice(2)); //slice off executable path and file path
const parameters = initializeArchivistParameters(args)
LOG('-Concluded Archivist Operations-')

function initializeArchivistParameters(args: minimist.ParsedArgs) : ArchivistParameters {
    const archivistParameters = new ArchivistParameters()
    if (args.config) {
        LOG(`Config file provided. Loading data and assigning parameters :: "${args.config}"`)
        const fullConfigPath = path.resolve(process.cwd(), args.config)
        LOG(`Config path resolved as :: ${fullConfigPath}`)
        try {
            const textFile = fs.readFileSync(fullConfigPath, 'utf8')
            const configObject = JSON.parse(textFile)

            archivistParameters.sourceType = configObject.sourceType
            archivistParameters.sourcePath = configObject.sourcePath
            archivistParameters.sourceParams = configObject.sourceParams
            archivistParameters.destinationType = configObject.destinationType
            archivistParameters.destinationPath = configObject.destinationPath

        } catch (err) {
            LOG(`Unable to load provided file. Terminating :: ${fullConfigPath}`)
            throw err
        }
    }

    LOG('Assigning parameters from process args')
    if (args.sourceType) {
        archivistParameters.sourceType = args.sourceType
    }
    if (args.sourcePath) {
        archivistParameters.sourcePath = args.sourcePath
    }
    if (args.sourceParams) {
        archivistParameters.sourceParams = JSON.parse(args.sourceParams)
    }
    if (args.destinationType) {
        archivistParameters.destinationType = args.destinationType
    }
    if (args.destinationPath) {
        archivistParameters.destinationPath = args.destinationPath
    }

    LOG('Finished parsing final archivist parameters:')
    LOG(archivistParameters)

    return archivistParameters
}

