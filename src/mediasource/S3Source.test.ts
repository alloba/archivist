import {describe, it, mock} from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import S3Source from './S3Source.js'
import FakeS3 from '../testing/FakeS3.js'
import {MANIFEST_FILENAME} from '../hashindex/HashIndex.js'

mock.method(console, 'log', () => undefined)
mock.method(console, 'warn', () => undefined)

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')

const make = (extraArgs: object = {}, s3 = new FakeS3()) => {
    const source = new S3Source({region: 'us-east-1', bucket: 'b', path: 'wsg', ...extraArgs})
    source.s3 = s3 as any
    return {source, s3}
}

describe('S3Source', () => {
    it('returns metadata with hashes taken from content rather than ETags', async () => {
        const {source, s3} = make()
        s3.seed('wsg/a.webm', 'aaa', 'bogus-etag')

        const metas = await source.scanForMetadata()

        assert.equal(metas.length, 1)
        assert.equal(metas[0].name, 'a.webm')
        assert.equal(metas[0].uri, 'wsg/a.webm')
        assert.equal(metas[0].extension, '.webm')
        assert.equal(metas[0].md5, md5('aaa'))
    })

    it('does not download objects that are already in the manifest', async () => {
        const first = make()
        first.s3.seed('wsg/a.webm', 'aaa')
        await first.source.scanForMetadata()
        first.s3.calls = []

        const metas = await make({}, first.s3).source.scanForMetadata()

        assert.equal(metas.length, 1)
        assert.equal(first.s3.callsTo('getObject').filter(x => x.key !== 'wsg/' + MANIFEST_FILENAME).length, 0)
    })

    it('does not report the manifest as media', async () => {
        const first = make()
        first.s3.seed('wsg/a.webm', 'aaa')
        await first.source.scanForMetadata()

        const metas = await make({}, first.s3).source.scanForMetadata()

        assert.deepEqual(metas.map(x => x.name), ['a.webm'])
    })

    it('keeps working if the manifest cannot be saved', async () => {
        const {source, s3} = make()
        s3.seed('wsg/a.webm', 'aaa')
        const originalPut = s3.putObject.bind(s3)
        s3.putObject = async () => {
            throw Object.assign(Error('AccessDenied'), {name: 'AccessDenied'})
        }

        const metas = await source.scanForMetadata()

        assert.equal(metas.length, 1)
        s3.putObject = originalPut
    })

    it('supports requireManifest and seedFromEtag', async () => {
        const strict = make({requireManifest: true})
        strict.s3.seed('wsg/a.webm', 'aaa')
        await assert.rejects(strict.source.scanForMetadata(), /requireManifest/)

        const seeded = make({seedFromEtag: true})
        seeded.s3.seed('wsg/a.webm', 'aaa')
        const metas = await seeded.source.scanForMetadata()
        assert.equal(metas[0].md5, md5('aaa'))
        assert.equal(seeded.s3.callsTo('getObject').filter(x => x.key === 'wsg/a.webm').length, 0)
    })

    it('downloads file contents by key', async () => {
        const {source, s3} = make()
        s3.seed('wsg/a.webm', 'aaa')
        const [meta] = await source.scanForMetadata()

        assert.equal((await source.downloadFile(meta)).toString(), 'aaa')
    })
})
