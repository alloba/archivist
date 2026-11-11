import path from 'path'
import fs from 'fs'
import FileMeta from "../model/FileMeta.js";
import FileUtils from "../FileUtils.js";
import {DestinationInterface} from "./DestinationInterface.js";
import {HashIndex, indexOptionsFromArgs, MANIFEST_FILENAME, TEMP_SUFFIX} from "../hashindex/HashIndex.js";
import FileSystemBacking from "../hashindex/FileSystemBacking.js";

export default class FileSystemDestination implements DestinationInterface {
    basepath: string
    private index: HashIndex

    constructor(destinationargs: any) {
        if (!destinationargs) {
            this.printHelp()
            throw Error('Missing or undefined destinationargs found during initialization of FileSystemDestination')
        }
        if (!destinationargs.path) {
            this.printHelp()
            throw Error('Missing required argument for destination initialization :: ' + 'destination.path')
        }
        this.basepath = path.resolve(process.cwd(), destinationargs.path)
        this.index = new HashIndex(new FileSystemBacking(this.basepath), indexOptionsFromArgs(destinationargs))

        console.log('File System destination has been initialized.')
        console.log(`Folder Path: ${this.basepath}\n`)
    }

    public printHelp(): void {
        console.log(
            `
Required parameters for FileSystemDestination:
    destination.path - The path to the folder that is being targeted.
                       The folder must already exist. This path can be relative.
Optional parameters:
    destination.requireManifest - Abort unless ${MANIFEST_FILENAME} already exists in the folder.
                                  Guards against writing into an empty, unmounted network share.
    destination.rebuild         - Ignore cached hashes and re-hash every file in the folder.
            `
        )
    }

    public async saveMedia(filemeta: FileMeta, rawfilepromise: Promise<Buffer>): Promise<void> {
        await this.index.ensureLoaded()
        if (this.index.hasHash(filemeta.md5)) {
            return
        }

        const raw = await rawfilepromise
        const filename = FileUtils.getUniqueName(filemeta.name)
        if (this.index.hasName(filename)) {
            throw Error('Generated filename collides with an existing file. Refusing to overwrite. :: ' + filename)
        }

        const newpath = path.resolve(this.basepath, filename)
        const temppath = newpath + TEMP_SUFFIX
        await fs.promises.writeFile(temppath, raw)
        await fs.promises.rename(temppath, newpath)

        const stat = await fs.promises.stat(newpath)
        // filemeta.md5 is also remembered, so a source reporting a differing hash still isn't saved twice in one run
        this.index.record({name: filename, md5: FileUtils.getMd5(raw), size: stat.size, mtimeMs: stat.mtimeMs}, filemeta.md5)
    }

    public async getExistingMeta(): Promise<FileMeta[]> {
        await this.index.sync()
        return this.index.entries().map(x => new FileMeta(x.name, path.resolve(this.basepath, x.name), path.extname(x.name), x.md5))
    }

    /** Persists any changes to the manifest. Should be called once at the end of a run. */
    public async close(): Promise<void> {
        await this.index.flush()
    }
}
