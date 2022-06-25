import {ArchivistParameters} from "../ArchivistParameters";
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

const LOG = console.log

export class FileSystemSource implements MediaSourceInterface {
    name: string;
    description: string;
    type: string;
    path: string;
    params: object;
    supportedFileTypes: Array<string>

    searchFunction: MediaSourceSearchFunc = (pathString: string, searchTerm: null | string, fileTypes: Array<string>): Array<MediaSearchResult> => {
        const basePath = path.resolve(process.cwd(), pathString)
        LOG(`Searching for files in directory using search term :: ${basePath} : ${searchTerm}`)
        try {
            const allFilesInDirectory = fs.readdirSync(basePath, {withFileTypes: true})
                .filter(x => x.isFile)
                .filter(x => x.name.split('.').length > 1)
            LOG(`Total number of files found in directory :: ${allFilesInDirectory.length}`)

            const matchingFiles = allFilesInDirectory
                .filter(x => {
                    return fileTypes.includes(x.name.split('.').pop() as string)
                })
                .filter(x => {
                    const typeSection = x.name.split('.').pop() as string
                    const name = x.name.substring(0, x.name.length - (typeSection.length + 1)) // +1 for the '.' in the file extension
                    return name == searchTerm
                })
            LOG(`Matching files in directory :: ${matchingFiles.length}`)
            return matchingFiles.map(x => new FsSearchResult(path.join(basePath, x.name), null, null))
        } catch (err) {
            LOG(`Unable to list files for provided directory in FsSearchFunction :: ${basePath}`)
            throw err
        }
    }

    downloadFunction: MediaSourceDownloadFunc = () => null; //TODO implement
    verifyParamsFunction: MediaSourceVerifyParamsFunc = () => null; //TODO implement

    constructor(archivistParameters: ArchivistParameters) {
        this.name = "File System Source"
        this.description = "Use a directory accessible by the current device as a source for media."
        this.type = "fs"
        this.supportedFileTypes = archivistParameters.supportedTypes
        this.path = archivistParameters.sourcePath
        this.params = archivistParameters.sourceParams
    }
}

class FsSearchResult implements MediaSearchResult {
    path: string;
    meta: object;
    hash: string | null

    constructor(path: string, meta: object | null, hash: string | null) {
        this.path = path
        this.meta = meta == null ? {} : meta
        this.hash = hash
    }

    /**
     * The generally desired hash for a file is a hex encoded md5 checksum.
     * This is consistent with what is available in the ETag for S3 bucket objects,
     * as well as what is provided via 4chan's api (which is a different source, but consistent is good)
     */
    getHashFunction: MediaSearchResultHashFunction = () : string => {
        if (this.hash != null){
            return this.hash
        }

        this.hash = crypto.createHash('md5').update(fs.readFileSync(this.path)).digest('hex')
        return this.hash
    };
}
