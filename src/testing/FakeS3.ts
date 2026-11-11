import crypto from 'crypto'
import {Readable} from 'stream'

interface StoredObject {
    body: Buffer
    etag: string
    lastModified: Date
}

/**
 * Just enough of the S3 client for tests: an in-memory bucket that records every call made against it.
 * Only a single bucket is modelled, and the Bucket argument is ignored.
 */
export default class FakeS3 {
    objects = new Map<string, StoredObject>()
    calls: { op: string, key?: string, args: any }[] = []
    pageSize = 1000
    private clock = Date.UTC(2026, 0, 1)

    /** Adds an object directly, as if something else had uploaded it. `etag` can be overridden to simulate multipart uploads. */
    seed(key: string, content: string, etag?: string): void {
        const body = Buffer.from(content)
        this.objects.set(key, {
            body,
            etag: etag ?? crypto.createHash('md5').update(body).digest('hex'),
            lastModified: new Date((this.clock += 60_000))
        })
    }

    callsTo(op: string): { op: string, key?: string, args: any }[] {
        return this.calls.filter(x => x.op === op)
    }

    async listObjectsV2(args: any) {
        this.calls.push({op: 'listObjectsV2', args})
        const keys = [...this.objects.keys()].filter(k => k.startsWith(args.Prefix ?? '')).sort()
        const start = args.ContinuationToken ? Number(args.ContinuationToken) : 0
        const page = keys.slice(start, start + this.pageSize)
        const truncated = start + this.pageSize < keys.length
        return {
            Contents: page.map(k => ({
                Key: k,
                Size: this.objects.get(k)!.body.length,
                ETag: `"${this.objects.get(k)!.etag}"`,
                LastModified: this.objects.get(k)!.lastModified
            })),
            IsTruncated: truncated,
            NextContinuationToken: truncated ? String(start + this.pageSize) : undefined
        }
    }

    async getObject(args: any) {
        this.calls.push({op: 'getObject', key: args.Key, args})
        const object = this.objects.get(args.Key)
        if (!object) {
            throw Object.assign(Error('The specified key does not exist.'), {name: 'NoSuchKey'})
        }
        return {Body: Object.assign(Readable.from([object.body]), {transformToString: async () => object.body.toString()})}
    }

    async putObject(args: any) {
        this.calls.push({op: 'putObject', key: args.Key, args})
        this.seed(args.Key, Buffer.isBuffer(args.Body) ? args.Body.toString() : String(args.Body))
        return {}
    }

    async headObject(args: any) {
        this.calls.push({op: 'headObject', key: args.Key, args})
        const object = this.objects.get(args.Key)
        if (!object) {
            throw Object.assign(Error('Not Found'), {name: 'NotFound'})
        }
        return {LastModified: object.lastModified, ContentLength: object.body.length}
    }
}
