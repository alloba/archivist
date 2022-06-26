import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import FileMeta from "../model/FileMeta.js";

const LOG = console.log

export class FileSystemSource {
    id: string
    basepath: string

    constructor(basepath: string) {
        this.id = 'fs'
        this.basepath = basepath
    }

    public async scanForMetadata(): Promise<Array<FileMeta>> {
        const absPath = path.resolve(process.cwd(), this.basepath)
        return fs.promises.readdir(absPath, {withFileTypes: true})
            .then(x =>
                x.filter(x => x.isFile)
                    .filter(x => x.name.split('.').length > 1)
                    .map(x => {
                        const uri = path.resolve(absPath, x.name)
                        const rawfile = fs.readFileSync(uri)
                        return new FileMeta(path.basename(uri), uri, path.extname(uri), this.getMd5(rawfile))
                    }))
    }

    public async downloadFile(filemeta: FileMeta): Promise<Buffer> {
        return fs.promises.readFile(filemeta.uri)
    }

    private getMd5(rawfile: Buffer): string {
        return crypto.createHash('md5').update(rawfile).digest('hex')
    }
}

