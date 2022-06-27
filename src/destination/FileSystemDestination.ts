import path from 'path'
import fs from 'fs'
import FileMeta from "../model/FileMeta.js";
import FileUtils from "../FileUtils.js";
import {DestinationInterface} from "./DestinationInterface.js";

export default class FileSystemDestination implements DestinationInterface {
    basepath: string
    existingMeta: FileMeta[] | null

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
        this.existingMeta = null

        console.log('File System destination has been initialized.')
        console.log(`Folder Path: ${this.basepath}\n`)
    }

    public printHelp(): void {
        console.log(
            `
            Required parameters for FileSystemDestination: 
                destination.path - The path to the folder that is being targeted. 
                                   The folder must already exist. This path can be relative.
            `
        )
    }

    public async saveMedia(filemeta: FileMeta, rawfilepromise: Promise<Buffer>): Promise<void> {
        if (await this.doesFileAlreadyExist(filemeta)) {
            return Promise.resolve()
        }

        const newpath = path.resolve(this.basepath, FileUtils.getUniqueName(filemeta.name))
        return rawfilepromise
            .then(raw => fs.promises.writeFile(newpath, raw))
            .then(_ => this.existingMeta?.push(filemeta))
            .then(() => Promise.resolve())
    }

    public async getExistingMeta(): Promise<FileMeta[]> {
        const dirlist = await fs.promises.readdir(this.basepath, {withFileTypes: true})
        const meta = dirlist.filter(x => x.isFile).map(async x => {
            const uri = path.resolve(this.basepath, x.name)
            const rawfile = await fs.promises.readFile(uri)
            return new FileMeta(path.basename(uri), uri, path.extname(uri), FileUtils.getMd5(rawfile))
        })
        const metaresult = await Promise.all(meta)
        this.existingMeta = metaresult
        return metaresult
    }

    private async doesFileAlreadyExist(filemeta: FileMeta): Promise<boolean> {
        if (this.existingMeta == null) {
            this.existingMeta = await this.getExistingMeta()
        }
        return this.existingMeta.map(z => z.md5).includes(filemeta.md5)
    }
}
