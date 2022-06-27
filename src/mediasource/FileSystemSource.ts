import path from 'path'
import fs from 'fs'
import FileMeta from "../model/FileMeta.js";
import FileUtils from "../FileUtils.js";
import {SourceInterface} from "./SourceInterface.js";

export default class FileSystemSource implements SourceInterface {
    id: string
    path: string

    constructor(sourceargs: any) {
        if(!sourceargs){
            throw Error('Missing or undefined sourceargs found during initialization of FileSystemSource')
        }
        if(!sourceargs.path){
            throw Error('Missing required argument for source initialization :: ' + 'source.path')
        }

        this.id = 'fs'
        this.path = sourceargs.path
    }

    public async scanForMetadata(): Promise<Array<FileMeta>> {
        const absPath = path.resolve(process.cwd(), this.path)
        return fs.promises.readdir(absPath, {withFileTypes: true})
            .then(x =>
                x.filter(x => x.isFile)
                    .filter(x => x.name.split('.').length > 1)
                    .map(x => {
                        const uri = path.resolve(absPath, x.name)
                        const rawfile = fs.readFileSync(uri)
                        return new FileMeta(path.basename(uri), uri, path.extname(uri), FileUtils.getMd5(rawfile))
                    }))
    }

    public async downloadFile(filemeta: FileMeta): Promise<Buffer> {
        return fs.promises.readFile(filemeta.uri)
    }
}

