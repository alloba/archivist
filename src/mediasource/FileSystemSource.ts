import path from 'path'
import fs from 'fs'
import FileMeta from "../model/FileMeta.js";
import {SourceInterface} from "./SourceInterface.js";
import {HashIndex, indexOptionsFromArgs, MANIFEST_FILENAME} from "../hashindex/HashIndex.js";
import FileSystemBacking from "../hashindex/FileSystemBacking.js";

export default class FileSystemSource implements SourceInterface {
    path: string
    private index: HashIndex

    constructor(sourceargs: any) {
        if (!sourceargs) {
            this.printHelp()
            throw Error('Missing or undefined sourceargs found during initialization of FileSystemSource')
        }
        if (!sourceargs.path) {
            this.printHelp()
            throw Error('Missing required argument for source initialization :: ' + 'source.path')
        }

        this.path = sourceargs.path
        // The manifest is saved in the source folder as a cache, but a source may be read-only, so failing to
        // write it only produces a warning.
        this.index = new HashIndex(
            new FileSystemBacking(path.resolve(process.cwd(), this.path)),
            indexOptionsFromArgs(sourceargs, true))
        console.log('File System source has been initialized.')
        console.log(`Folder Path: ${this.path}`)
        console.log()
    }

    public printHelp(): void {
        console.log(
            `
Required parameters for FileSystemSource: 
    source.path - The path to the folder that is being targeted. 
                  The folder must already exist. This path can be relative. 
Optional parameters:
    source.requireManifest - Abort unless ${MANIFEST_FILENAME} already exists in the folder.
    source.rebuild         - Ignore cached hashes and re-hash every file in the folder.
            `
        )
    }

    public async scanForMetadata(): Promise<Array<FileMeta>> {
        const absPath = path.resolve(process.cwd(), this.path)
        await this.index.sync()
        return this.index.entries()
            .filter(x => x.name.split('.').length > 1)
            .map(x => new FileMeta(x.name, path.resolve(absPath, x.name), path.extname(x.name), x.md5))
    }

    public async downloadFile(filemeta: FileMeta): Promise<Buffer> {
        return fs.promises.readFile(filemeta.uri)
    }
}

