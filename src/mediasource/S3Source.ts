import FileMeta from "../model/FileMeta.js";
import {ListObjectsV2Output, S3} from "@aws-sdk/client-s3";
import {SourceInterface} from "./SourceInterface.js";
import {Readable} from "stream";

export default class S3Source implements SourceInterface {
    bucketname: string
    basepath: string
    s3: S3

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
            throw Error('Missing required argument for source initialization :: ' + 'source.bucketname')
        }
        if (!sourceargs.region) {
            this.printHelp()
            throw Error('Missing required argument for source initialization :: ' + 'source.region')
        }

        this.bucketname = sourceargs.bucket
        this.basepath = sourceargs.path.endsWith('/') ? sourceargs.path : sourceargs.path + '/'
        this.s3 = new S3({region: sourceargs.region})

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
            `
        )
    }

    public async scanForMetadata(): Promise<FileMeta[]> {
        let imageMetas: FileMeta[] = [];
        let continuationToken = undefined
        while (true) {
            const datachunk: ListObjectsV2Output = await this.s3.listObjectsV2({
                Delimiter: "",
                Bucket: this.bucketname,
                Prefix: this.basepath,
                ContinuationToken: continuationToken
            });
            datachunk.Contents?.filter(x => x !== undefined)
                .map(x => {
                    if (x.Key == undefined) {
                        throw Error('Key undefined for S3 object, which should never be impossible. Aborting.')
                    }
                    const filename = x.Key.split("/").pop() as string
                    const extension = '.' + filename.split(".").pop() as string
                    const md5 = (x.ETag as string).replaceAll('"', '')
                    return new FileMeta(filename, x.Key as string, extension, md5)
                })
                .forEach(x => imageMetas.push(x))

            if (!datachunk.IsTruncated) {
                break
            }
            continuationToken = datachunk.NextContinuationToken;
        }
        return imageMetas
    }

    public async downloadFile(filemeta: FileMeta): Promise<Buffer> {
        // This is a kind of workaround to get the response body back to being a buffer, await from the
        // readable stream that aws shifted to for v3.
        // It feels like it goes kind of slowly, but it does indeed work.
        // (Also I'm basically never going to use this so who cares)
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
