import path from 'path'
import fs from 'fs'
import FileMeta from "../model/FileMeta.js";
import FileUtils from "../FileUtils.js";

export default class FileSystemDestination {
    basepath: string
    existingHashes: string[] | null

    constructor(destinationargs: any) {
        if(!destinationargs){
            throw Error('Missing or undefined destinationargs found during initialization of FileSystemDestination')
        }
        if(!destinationargs.path){
            throw Error('Missing required argument for destination initialization :: ' + 'destination.path')
        }
        this.basepath = path.resolve(process.cwd(), destinationargs.path)
        this.existingHashes = null
    }


    public async saveMedia(filemeta: FileMeta, rawfilepromise: Promise<Buffer>): Promise<void> {
        if(await this.doesFileAlreadyExist(filemeta)){
            return Promise.resolve()
        }

        const newpath = path.resolve(this.basepath, FileUtils.getUniqueName(filemeta.name))
        return rawfilepromise
            .then(raw => fs.promises.writeFile(newpath, raw))
            .then(_ => this.existingHashes?.push(filemeta.md5))
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
        this.existingHashes = metaresult.map(x => x.md5)
        return metaresult
    }

    public async doesFileAlreadyExist(filemeta: FileMeta): Promise<boolean> {
        if (this.existingHashes == null) {
            this.existingHashes = await this.getExistingMeta().then(x => x.map(z => z.md5))
        }
        return Promise.resolve((this.existingHashes as string[]).includes(filemeta.md5))
    }
}
