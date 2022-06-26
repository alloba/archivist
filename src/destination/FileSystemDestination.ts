import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import FileMeta from "../model/FileMeta.js";

export default class FileSystemDestination {
    basepath: string
    existingHashes: string[] | null

    constructor(basepath: string) {
        this.basepath = path.resolve(process.cwd(), basepath)
        this.existingHashes = null
    }


    public async saveMedia(filemeta: FileMeta, rawfilepromise: Promise<Buffer>): Promise<void> {
        const newpath = path.resolve(this.basepath, this.getUniqueName(filemeta.name))
        return rawfilepromise
            .then(raw => fs.promises.writeFile(newpath, raw))
            .then(() => Promise.resolve())
    }

    //TODO: shift this into some util class.
    private getUniqueName(filename: string): string {
        const shortname = filename.substring(0, filename.lastIndexOf('.'))
        const timestamp = new Date().getTime()
        return shortname + '_' + timestamp + '.' + filename.split('.').pop()
    }

    private async getExistingMeta(): Promise<FileMeta[]> {
        const dirlist = await fs.promises.readdir(this.basepath, {withFileTypes: true})
        const meta = dirlist.filter(x => x.isFile).map(async x => {
            const uri = path.resolve(this.basepath, x.name)
            const rawfile = await fs.promises.readFile(uri)
            return new FileMeta(path.basename(uri), uri, path.extname(uri), this.getMd5(rawfile))
        })

        return Promise.all(meta)
    }

    public async doesFileAlreadyExist(filemeta: FileMeta): Promise<boolean> {
        if (this.existingHashes == null) {
            this.existingHashes = await this.getExistingMeta().then(x => x.map(z => z.md5))
        }
        return Promise.resolve((this.existingHashes as string[]).includes(filemeta.md5))
    }

    //TODO: merge this and the one in the fs source
    private getMd5(rawfile: Buffer): string {
        return crypto.createHash('md5').update(rawfile).digest('hex')
    }
}
