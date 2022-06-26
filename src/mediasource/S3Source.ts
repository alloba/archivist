import FileMeta from "../model/FileMeta.js";
import S3 from 'aws-sdk/clients/s3.js';

export default class S3Source {
    id: string
    basepath: string
    s3: S3
    bucketname: string

    constructor(basepath: string, region: string, bucket: string) {
        if(!process.env.AWS_ACCESS_KEY_ID){
            throw Error('Missing AWS_ACCESS_KEY_ID in environment variables')
        }
        if(!process.env.AWS_SECRET_ACCESS_KEY){
            throw Error('Missing AWS_SECRET_ACCESS_KEY in environment variables')
        }

        this.id = 's3'
        this.basepath = basepath
        this.bucketname = bucket
        this.s3 = new S3({region: region})
    }

    public async scanForMetadata(): Promise<FileMeta[]>{
        console.log('entering scan method')
        let imageMetas: FileMeta[] = [];
        let continuationToken = undefined
        while(true){
            const datachunk: S3.ListObjectsV2Output = await this.s3.listObjectsV2({Delimiter: "", Bucket: this.bucketname, Prefix: this.basepath, ContinuationToken: continuationToken}).promise();
            console.log(datachunk)
            datachunk.Contents?.filter(x => x !== undefined)
                .map(x => {
                    if(x.Key == undefined){
                        throw Error('Key undefined for S3 object, which should never be impossible. Aborting.')
                    }
                    const filename = x.Key.split("/").pop() as string
                    const extension = '.' + filename.split(".").pop() as string
                    const md5 = (x.ETag as string).replaceAll('"','')
                    return new FileMeta(filename, x.Key as string, extension, md5)
                })
                .forEach(x => imageMetas.push(x))

            if(! datachunk.IsTruncated){
                break
            }
            continuationToken = datachunk.NextContinuationToken;
        }
        return imageMetas
    }

    public async downloadFile(filemeta: FileMeta): Promise<Buffer> {
        const bucketObject = await this.s3.getObject({Bucket: this.bucketname, Key: filemeta.uri}).promise()
        if(bucketObject.Body == undefined){
            throw Error('Got an empty body on S3 download operation for item. Aborting. :: ' + filemeta.uri)
        }
        return bucketObject.Body as Buffer
    }
}
