import crypto from 'crypto'
import {Readable} from 'stream'
import {S3} from '@aws-sdk/client-s3'
import {
    IndexBacking,
    INDEX_FILENAME,
    ListedItem,
    MANIFEST_FILENAME,
    ManifestEntry,
    parseManifest,
    serializeIndex,
    serializeManifest
} from './HashIndex.js'

/**
 * An S3 prefix. The manifest is an object stored at `<prefix>/.archivist-manifest.json`.
 *
 * Note that the md5 values come from the manifest (or from reading objects), not from S3 metadata. The one exception
 * is `hintMd5`: an ETag that looks like a plain md5 is offered as a hint, which the index only uses when explicitly
 * told to (seedFromEtag), to bootstrap a manifest without downloading every object.
 */
export default class S3Backing implements IndexBacking {
    private manifestKey: string
    private indexKey: string

    /** `getClient` is a function so owners can swap their client (e.g. for tests) after construction. */
    constructor(private getClient: () => S3, public bucket: string, public prefix: string) {
        this.manifestKey = prefix + MANIFEST_FILENAME
        this.indexKey = prefix + INDEX_FILENAME
    }

    describe(): string {
        return `s3://${this.bucket}/${this.prefix}`
    }

    async assertReachable(): Promise<void> {
        // Nothing to check up front. Listing fails loudly if the bucket or credentials are wrong.
    }

    async readManifest(): Promise<ManifestEntry[] | null> {
        let text: string
        try {
            const response = await this.getClient().getObject({Bucket: this.bucket, Key: this.manifestKey})
            if (!response.Body) {
                throw Error('Got an empty body when reading manifest. :: ' + this.describe())
            }
            text = await response.Body.transformToString()
        } catch (e: any) {
            if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) {
                return null
            }
            throw e
        }
        return parseManifest(text, this.describe() + MANIFEST_FILENAME)
    }

    /** Deliberately no ACL: unlike the media, the manifest is not public. */
    async writeManifest(entries: ManifestEntry[]): Promise<void> {
        await this.getClient().putObject({
            Bucket: this.bucket,
            Key: this.manifestKey,
            Body: serializeManifest(entries),
            ContentType: 'application/json',
        })
    }

    /**
     * No ACL here either (the bucket policy decides who can read). `no-cache` makes browsers revalidate on every load
     * (cheap, via the ETag) instead of serving a stale list for hours.
     */
    async writeIndex(names: string[]): Promise<void> {
        await this.getClient().putObject({
            Bucket: this.bucket,
            Key: this.indexKey,
            Body: serializeIndex(names),
            ContentType: 'application/json',
            CacheControl: 'no-cache',
        })
    }

    async list(): Promise<ListedItem[]> {
        const items: ListedItem[] = []
        let continuationToken: string | undefined = undefined
        while (true) {
            const chunk: any = await this.getClient().listObjectsV2({
                Delimiter: '',
                Bucket: this.bucket,
                Prefix: this.prefix,
                ContinuationToken: continuationToken
            })
            for (const object of chunk.Contents ?? []) {
                if (object.Key == undefined) {
                    throw Error('Key undefined for S3 object, which should never be impossible. Aborting.')
                }
                if (object.Key === this.manifestKey || object.Key === this.indexKey || object.Key.endsWith('/')) {
                    continue // the manifest and index, and console-created "folder" placeholders
                }
                if (object.LastModified == undefined) {
                    throw Error('S3 listing returned no LastModified for object. Aborting. :: ' + object.Key)
                }
                const etag = (object.ETag ?? '').replaceAll('"', '')
                items.push({
                    name: object.Key.slice(this.prefix.length),
                    size: object.Size ?? 0,
                    mtimeMs: object.LastModified.getTime(),
                    // Multipart and KMS-encrypted uploads have ETags that are not an md5, and are not offered.
                    hintMd5: /^[0-9a-f]{32}$/i.test(etag) ? etag.toLowerCase() : undefined,
                })
            }
            if (!chunk.IsTruncated) {
                break
            }
            continuationToken = chunk.NextContinuationToken
        }
        return items
    }

    /** Streams the object through the hash, so large objects are never held in memory. */
    async hash(item: ListedItem): Promise<string> {
        const response = await this.getClient().getObject({Bucket: this.bucket, Key: this.prefix + item.name})
        if (!response.Body) {
            throw Error('Got an empty body on S3 download operation for item. Aborting. :: ' + item.name)
        }
        const body = response.Body as Readable
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('md5')
            body.on('error', reject)
                .on('data', chunk => hash.update(chunk))
                .on('end', () => resolve(hash.digest('hex')))
        })
    }
}
