import FileMeta from "../model/FileMeta.js";
import S3 from "aws-sdk/clients/s3.js";
import FileUtils from "../FileUtils.js";
import {DestinationInterface} from "./DestinationInterface.js";

export default class S3Destination implements DestinationInterface {
    basepath: string
    existingHashes: string[] | null
    bucket: string
    s3: S3

    constructor(destinationargs: any) {

        if (!destinationargs) {
            throw Error('Missing or undefined destinationargs found during initialization of S3Destination')
        }
        if (!destinationargs.path) {
            throw Error('Missing required argument for destination initialization :: ' + 'destination.path')
        }
        if (!destinationargs.bucket) {
            throw Error('Missing required argument for destination initialization :: ' + 'destination.bucket')
        }
        if (!destinationargs.region) {
            throw Error('Missing required argument for destination initialization :: ' + 'destination.region')
        }

        this.basepath = destinationargs.path.endsWith('/') ? destinationargs.path : destinationargs.path + '/'
        this.bucket = destinationargs.bucket
        this.existingHashes = null
        this.s3 = new S3({region: destinationargs.region})
    }

    public async saveMedia(filemeta: FileMeta, rawfilepromise: Promise<Buffer>): Promise<void> {
        if (await this.doesFileAlreadyExist(filemeta)) {
            console.log('File already exists in destination bucket. Skipping. :: ' + filemeta.name)
            return Promise.resolve()
        }

        const filename = FileUtils.getUniqueName(filemeta.name)
        const filecontents = await rawfilepromise

        //TODO: trying to get away with leaving out contenttype to easily handle future files, but need to verify that this works.
        //TODO: also should do proper error handling on this operation...
        await this.s3.putObject({
            Bucket: this.bucket,
            Key: this.basepath + filename,
            Body: filecontents,
            ContentType: this.determineContentType(filemeta),
            ACL: 'public-read'
        }).promise()
        return Promise.resolve()
    }

    public async getExistingMeta(): Promise<FileMeta[]> {
        let imageMetas: FileMeta[] = [];
        let continuationToken = undefined
        while (true) {
            const datachunk: S3.ListObjectsV2Output = await this.s3.listObjectsV2({
                Delimiter: "",
                Bucket: this.bucket,
                Prefix: this.basepath,
                ContinuationToken: continuationToken
            }).promise();
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

    public async doesFileAlreadyExist(filemeta: FileMeta): Promise<boolean> {
        if (this.existingHashes == null) {
            this.existingHashes = await this.getExistingMeta().then(x => x.map(z => z.md5))
        }
        return Promise.resolve((this.existingHashes as string[]).includes(filemeta.md5))
    }

    private determineContentType(filemeta: FileMeta): string {
        switch (filemeta.extension){
            case '.webm': {
                return 'video/webm'
            }
            default: {
                throw Error('Unsupported extension for file detected. Refusing to save to S3. :: ' + filemeta.name)
            }
        }
    }
}
