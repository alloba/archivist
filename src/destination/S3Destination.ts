import path from "path";
import FileMeta from "../model/FileMeta.js";
import {S3} from "@aws-sdk/client-s3";
import FileUtils from "../FileUtils.js";
import {DestinationInterface} from "./DestinationInterface.js";
import {HashIndex, indexOptionsFromArgs, MANIFEST_FILENAME} from "../hashindex/HashIndex.js";
import S3Backing from "../hashindex/S3Backing.js";

export default class S3Destination implements DestinationInterface {
    basepath: string
    bucket: string
    s3: S3
    private index: HashIndex

    constructor(destinationargs: any) {
        if (!destinationargs) {
            this.printHelp()
            throw Error('Missing or undefined destinationargs found during initialization of S3Destination')
        }
        if (!destinationargs.path) {
            this.printHelp()
            throw Error('Missing required argument for destination initialization :: ' + 'destination.path')
        }
        if (!destinationargs.bucket) {
            this.printHelp()
            throw Error('Missing required argument for destination initialization :: ' + 'destination.bucket')
        }
        if (!destinationargs.region) {
            this.printHelp()
            throw Error('Missing required argument for destination initialization :: ' + 'destination.region')
        }

        this.basepath = destinationargs.path.endsWith('/') ? destinationargs.path : destinationargs.path + '/'
        this.bucket = destinationargs.bucket
        this.s3 = new S3({region: destinationargs.region})
        this.index = new HashIndex(new S3Backing(() => this.s3, this.bucket, this.basepath), indexOptionsFromArgs(destinationargs))

        console.log('S3 Destination has been initialized.')
        console.log(`Region: ${destinationargs.region}`)
        console.log(`Bucket: ${this.bucket}`)
        console.log(`Path: ${this.basepath}\n`)
    }

    public printHelp(): void {
        console.log(
            `
Required parameters for S3Destination:
    destination.region - The AWS region that the S3 bucket is located in.
    destination.bucket - The name of the S3 bucket
    destination.path   - The subfolder within the bucket to target.
                         This folder does not have to already exist in the bucket.
Optional parameters:
    destination.requireManifest - Abort unless ${MANIFEST_FILENAME} already exists under the path.
    destination.rebuild         - Ignore cached hashes and re-hash (download) every object.
    destination.seedFromEtag    - When there is no cached hash for an object, accept its ETag as the md5 instead of
                                  downloading it. Only for bootstrapping a manifest for objects that were uploaded
                                  in a single part. ETags that are not a plain md5 are never used this way.
            `
        )
    }

    public async saveMedia(filemeta: FileMeta, rawfilepromise: Promise<Buffer>, requestedName?: string): Promise<void> {
        await this.index.ensureLoaded()
        if (this.index.hasHash(filemeta.md5)) {
            console.log('File already exists in destination bucket. Skipping. :: ' + filemeta.name)
            return
        }

        const filename = requestedName ?? FileUtils.getUniqueName(filemeta.name)
        if (filename.includes('/') || filename === MANIFEST_FILENAME) {
            throw Error('Refusing to save under an unsafe filename. :: ' + filename)
        }
        if (this.index.hasName(filename)) {
            throw Error('Generated filename collides with an existing object. Refusing to overwrite. :: ' + filename)
        }
        const filecontents = await rawfilepromise
        const key = this.basepath + filename

        await this.s3.putObject({
            Bucket: this.bucket,
            Key: key,
            Body: filecontents,
            ContentType: this.determineContentType(filemeta),
            ACL: 'public-read'
        })

        // The modification time is what lets the next run trust this entry without re-reading the object.
        const head = await this.s3.headObject({Bucket: this.bucket, Key: key})
        if (!head.LastModified) {
            throw Error('S3 returned no LastModified for an object that was just uploaded. :: ' + key)
        }
        this.index.record(
            {name: filename, md5: FileUtils.getMd5(filecontents), size: filecontents.length, mtimeMs: head.LastModified.getTime()},
            filemeta.md5)
    }

    public async getExistingMeta(): Promise<FileMeta[]> {
        await this.index.sync()
        return this.index.entries().map(x => new FileMeta(x.name, this.basepath + x.name, path.extname(x.name), x.md5))
    }

    /** Persists any changes to the manifest. Should be called once at the end of a run. */
    public async close(): Promise<void> {
        await this.index.flush()
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
