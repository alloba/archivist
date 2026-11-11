import {describe, it, mock} from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import S3Backing from './S3Backing.js'
import FakeS3 from '../testing/FakeS3.js'
import {INDEX_FILENAME, MANIFEST_FILENAME} from './HashIndex.js'

mock.method(console, 'log', () => undefined)

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')

const make = (s3 = new FakeS3()) => ({s3, backing: new S3Backing(() => s3 as any, 'bucket', 'wsg/')})

describe('S3Backing published index', () => {
    it('writes names as JSON with no ACL and no-cache, and does not list it as media', async () => {
        const {s3, backing} = make()
        s3.seed('wsg/a.webm', 'aaa')

        await backing.writeIndex(['a.webm'])

        const put = s3.callsTo('putObject')[0]
        assert.equal(put.key, 'wsg/' + INDEX_FILENAME)
        assert.equal(put.args.ACL, undefined)
        assert.equal(put.args.CacheControl, 'no-cache')
        assert.deepEqual(JSON.parse(s3.objects.get(put.key!)!.body.toString()), {version: 1, files: ['a.webm']})
        assert.deepEqual((await backing.list()).map(x => x.name), ['a.webm'])
    })
})

describe('S3Backing', () => {
    describe('list', () => {
        it('lists names relative to the prefix, with sizes and modification times', async () => {
            const {s3, backing} = make()
            s3.seed('wsg/a.webm', 'aaa')

            const items = await backing.list()

            assert.equal(items.length, 1)
            assert.equal(items[0].name, 'a.webm')
            assert.equal(items[0].size, 3)
            assert.equal(items[0].mtimeMs, s3.objects.get('wsg/a.webm')!.lastModified.getTime())
        })

        it('follows pagination', async () => {
            const {s3, backing} = make()
            s3.pageSize = 2
            for (const n of ['a', 'b', 'c', 'd', 'e']) s3.seed(`wsg/${n}.webm`, n)

            const items = await backing.list()

            assert.deepEqual(items.map(x => x.name), ['a.webm', 'b.webm', 'c.webm', 'd.webm', 'e.webm'])
        })

        it('ignores other prefixes, the manifest, and folder placeholders', async () => {
            const {s3, backing} = make()
            s3.seed('wsg/a.webm', 'aaa')
            s3.seed('gondola/other.webm', 'zzz')
            s3.seed('wsg/' + MANIFEST_FILENAME, '{}')
            s3.seed('wsg/sub/', '')

            assert.deepEqual((await backing.list()).map(x => x.name), ['a.webm'])
        })

        it('offers an ETag as a hint only when it is a plain md5', async () => {
            const {s3, backing} = make()
            s3.seed('wsg/single.webm', 'one')
            s3.seed('wsg/multipart.webm', 'two', 'd41d8cd98f00b204e9800998ecf8427e-3')

            const items = new Map((await backing.list()).map(x => [x.name, x]))

            assert.equal(items.get('single.webm')!.hintMd5, md5('one'))
            assert.equal(items.get('multipart.webm')!.hintMd5, undefined)
        })
    })

    describe('manifest', () => {
        it('reads as null when none exists', async () => {
            assert.equal(await make().backing.readManifest(), null)
        })

        it('round-trips through the bucket under the prefix', async () => {
            const {s3, backing} = make()
            const entries = [{name: 'a.webm', md5: md5('aaa'), size: 3, mtimeMs: 5}]

            await backing.writeManifest(entries)

            assert.equal(s3.objects.has('wsg/' + MANIFEST_FILENAME), true)
            assert.deepEqual(await backing.readManifest(), entries)
        })

        it('is written without a public ACL', async () => {
            const {s3, backing} = make()
            await backing.writeManifest([])
            assert.equal(s3.callsTo('putObject')[0].args.ACL, undefined)
        })

        it('throws on a corrupt manifest', async () => {
            const {s3, backing} = make()
            s3.seed('wsg/' + MANIFEST_FILENAME, '{nope')
            await assert.rejects(backing.readManifest(), /not valid JSON/)
        })

        it('does not swallow errors other than "not found"', async () => {
            const {s3, backing} = make()
            s3.getObject = async () => {
                throw Object.assign(Error('denied'), {name: 'AccessDenied'})
            }
            await assert.rejects(backing.readManifest(), /denied/)
        })
    })

    it('hashes an object by reading it', async () => {
        const {s3, backing} = make()
        s3.seed('wsg/a.webm', 'aaa', 'not-the-real-hash-1')

        const hash = await backing.hash({name: 'a.webm', size: 3, mtimeMs: 0})

        assert.equal(hash, md5('aaa')) // from the content, not from the ETag
    })

    it('uses whichever client the owner currently has', async () => {
        const first = new FakeS3()
        let current = first
        const backing = new S3Backing(() => current as any, 'bucket', 'wsg/')
        const second = new FakeS3()
        second.seed('wsg/b.webm', 'bbb')
        current = second

        assert.deepEqual((await backing.list()).map(x => x.name), ['b.webm'])
    })
})
