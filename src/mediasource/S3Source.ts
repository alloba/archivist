import FileMeta from "../model/FileMeta.js";
import {S3} from "@aws-sdk/client-s3";
import {SourceInterface} from "./SourceInterface.js";
import {Readable} from "stream";
import path from "path";
import {HashIndex, indexOptionsFromArgs, MANIFEST_FILENAME} from "../hashindex/HashIndex.js";
import S3Backing from "../hashindex/S3Backing.js";

export default class S3Source implements SourceInterface {
    bucketname: string
    basepath: string
    s3: S3
    private index: HashIndex

    constructor(sourceargs: any) {
        if (!sourceargs) {
            this.printHelp()
            throw Error('Missing or undefined sourceargs found during initialization of S3Source')
        }
        if (!sourceargs.path) {
            this.printHelp()
            throw Error('Missing required argument for source initialization :: ' + 'source.path')
        }
        if (!sourceargs.bucket) {
            this.printHelp()
            throw Error('Missing required argument for source initialization :: ' + 'source.bucket')
        }
        if (!sourceargs.region) {
            this.printHelp()
            throw Error('Missing required argument for source initialization :: ' + 'source.region')
        }

        this.bucketname = sourceargs.bucket
        this.basepath = sourceargs.path.endsWith('/') ? sourceargs.path : sourceargs.path + '/'
        this.s3 = new S3({region: sourceargs.region})
        // The manifest is saved under the source path as a cache, but a source may be read-only, so failing to
        // write it only produces a warning.
        this.index = new HashIndex(
            new S3Backing(() => this.s3, this.bucketname, this.basepath),
            indexOptionsFromArgs(sourceargs, true))

        console.log('S3 Source has been initialized.')
        console.log(`Region: ${sourceargs.region}`)
        console.log(`Bucket: ${this.bucketname}`)
        console.log(`Path: ${this.basepath}\n`)
    }

    public printHelp(): void {
        console.log(
            `
Required parameters for S3Source: 
    source.region - The AWS region that the S3 bucket is located in.
    source.bucket - The name of the S3 bucket
    source.path   - The subfolder within the bucket to target. 
Optional parameters:
    source.requireManifest - Abort unless ${MANIFEST_FILENAME} already exists under the path.
    source.rebuild         - Ignore cached hashes and re-hash (download) every object.
    source.seedFromEtag    - When there is no cached hash for an object, accept its ETag as the md5 instead of
                             downloading it. Only for bootstrapping a manifest for objects that were uploaded
                             in a single part. ETags that are not a plain md5 are never used this way.
            `
        )
    }

    public async scanForMetadata(): Promise<FileMeta[]> {
        await this.index.sync()
        return this.index.entries().map(x => {
            const filename = x.name.split("/").pop() as string
            return new FileMeta(filename, this.basepath + x.name, path.extname(filename), x.md5)
        })
    }

    public async downloadFile(filemeta: FileMeta): Promise<Buffer> {
        // This is a kind of workaround to get the response body back to being a buffer, await from the
        // readable stream that aws shifted to for v3.
        // It feels like it goes kind of slowly, but it does indeed work.
        // (Also I'm basically never going to use this so who cares)
        // big thanks to stack overflow. https://stackoverflow.com/a/36944450
        return new Promise( async (resolve, reject) => {
            try {
                const bucketObject = await this.s3.getObject({Bucket: this.bucketname, Key: filemeta.uri})
                if (bucketObject.Body == undefined) {
                    reject(Error('Got an empty body on S3 download operation for item. Aborting. :: ' + filemeta.uri))
                }

                let chunks: any[] = []
                let bod = bucketObject.Body as Readable
                bod.once('error', err => reject(err))
                bod.on('data', chunk => chunks.push(chunk))
                bod.once('end', () => resolve(Buffer.concat(chunks)))
            } catch (err){
                reject(err)
            }
        })
    }
}
