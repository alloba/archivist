import FileMeta from "../model/FileMeta.js";
import S3 from 'aws-sdk/clients/s3.js';
import {SourceInterface} from "./SourceInterface.js";

export default class S3Source implements SourceInterface {
    bucketname: string
    basepath: string
    s3: S3

    constructor(sourceargs: any) {
        if (!process.env.AWS_ACCESS_KEY_ID) {
            this.printHelp()
            throw Error('Missing AWS_ACCESS_KEY_ID in environment variables')
        }
        if (!process.env.AWS_SECRET_ACCESS_KEY) {
            this.printHelp()
            throw Error('Missing AWS_SECRET_ACCESS_KEY in environment variables')
        }
        if (!sourceargs) {
            this.printHelp()
            throw Error('Missing or undefined sourceargs found during initialization of S3Source')
        }
        if (!sourceargs.path) {
            this.printHelp()
            throw Error('Missing required argument for source initialization :: ' + 'source.path')
        }
        if (!sourceargs.bucketname) {
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
                
            Required Environment Variables: 
                These must both be set OUTSIDE of script execution. They are used to configure the S3 client object.
                AWS_ACCESS_KEY_ID
                AWS_SECRET_ACCESS_KEY
            `
        )
    }

    public async scanForMetadata(): Promise<FileMeta[]> {
        console.log('entering scan method')
        let imageMetas: FileMeta[] = [];
        let continuationToken = undefined
        while (true) {
            const datachunk: S3.ListObjectsV2Output = await this.s3.listObjectsV2({
                Delimiter: "",
                Bucket: this.bucketname,
                Prefix: this.basepath,
                ContinuationToken: continuationToken
            }).promise();
            console.log(datachunk)
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
        const bucketObject = await this.s3.getObject({Bucket: this.bucketname, Key: filemeta.uri}).promise()
        if (bucketObject.Body == undefined) {
            throw Error('Got an empty body on S3 download operation for item. Aborting. :: ' + filemeta.uri)
        }
        return bucketObject.Body as Buffer
    }
}
