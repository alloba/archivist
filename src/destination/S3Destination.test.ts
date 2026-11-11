import {afterEach, describe, it, mock} from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import S3Destination from './S3Destination.js'
import FakeS3 from '../testing/FakeS3.js'
import FileMeta from '../model/FileMeta.js'
import {INDEX_FILENAME, MANIFEST_FILENAME, parseManifest} from '../hashindex/HashIndex.js'

mock.method(console, 'log', () => undefined)

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')
const meta = (name: string, content: string) => new FileMeta(name, name, '.webm', md5(content))
const manifestKey = 'wsg/' + MANIFEST_FILENAME

const make = (extraArgs: object = {}, s3 = new FakeS3()) => {
    const dest = new S3Destination({region: 'us-east-1', bucket: 'b', path: 'wsg', ...extraArgs})
    dest.s3 = s3 as any
    return {dest, s3}
}

const savedManifest = (s3: FakeS3) => parseManifest(s3.objects.get(manifestKey)!.body.toString(), 'test')

describe('S3Destination', () => {
    afterEach(() => {
        mock.restoreAll()
        mock.method(console, 'log', () => undefined)
    })

    describe('without a manifest', () => {
        it('hashes objects by downloading them, not by trusting ETags', async () => {
            const {dest, s3} = make()
            s3.seed('wsg/a.webm', 'aaa', 'bogus-etag')

            const existing = await dest.getExistingMeta()

            assert.deepEqual(existing.map(x => x.md5), [md5('aaa')])
            assert.equal(s3.callsTo('getObject').filter(x => x.key === 'wsg/a.webm').length, 1)
        })

        it('with seedFromEtag, takes plain-md5 ETags without downloading', async () => {
            const {dest, s3} = make({seedFromEtag: true})
            s3.seed('wsg/a.webm', 'aaa')

            const existing = await dest.getExistingMeta()

            assert.deepEqual(existing.map(x => x.md5), [md5('aaa')])
            assert.equal(s3.callsTo('getObject').filter(x => x.key === 'wsg/a.webm').length, 0)
        })

        it('with seedFromEtag, still downloads objects whose ETag is not a plain md5', async () => {
            const {dest, s3} = make({seedFromEtag: true})
            s3.seed('wsg/big.webm', 'bigcontent', 'd41d8cd98f00b204e9800998ecf8427e-12')

            const existing = await dest.getExistingMeta()

            assert.deepEqual(existing.map(x => x.md5), [md5('bigcontent')])
        })

        it('requireManifest fails before anything is downloaded or uploaded', async () => {
            const {dest, s3} = make({requireManifest: true})
            s3.seed('wsg/a.webm', 'aaa')

            await assert.rejects(dest.getExistingMeta(), /requireManifest/)

            assert.equal(s3.callsTo('putObject').length, 0)
            assert.equal(s3.callsTo('getObject').filter(x => x.key !== manifestKey).length, 0)
        })
    })

    describe('with a manifest', () => {
        it('does not download anything on later runs', async () => {
            const first = make()
            first.s3.seed('wsg/a.webm', 'aaa')
            await first.dest.getExistingMeta() // builds and saves the manifest

            const second = make({requireManifest: true}, first.s3)
            first.s3.calls = []
            const existing = await second.dest.getExistingMeta()

            assert.deepEqual(existing.map(x => x.md5), [md5('aaa')])
            assert.equal(first.s3.callsTo('getObject').filter(x => x.key !== manifestKey).length, 0)
        })

        it('only downloads objects that are new', async () => {
            const first = make()
            first.s3.seed('wsg/a.webm', 'aaa')
            await first.dest.getExistingMeta()
            first.s3.seed('wsg/b.webm', 'bbb') // uploaded by something else
            first.s3.calls = []

            await make({}, first.s3).dest.getExistingMeta()

            assert.deepEqual(first.s3.callsTo('getObject').map(x => x.key).filter(k => k !== manifestKey), ['wsg/b.webm'])
        })

        it('does not use the manifest object as media', async () => {
            const {dest, s3} = make()
            s3.seed('wsg/a.webm', 'aaa')
            await dest.getExistingMeta()

            const existing = await make({}, s3).dest.getExistingMeta()

            assert.deepEqual(existing.map(x => x.name), ['a.webm'])
        })
    })

    describe('saving', () => {
        it('uploads new files, skips existing ones and duplicates within the run', async () => {
            const {dest, s3} = make()
            s3.seed('wsg/a.webm', 'aaa')
            await dest.getExistingMeta()
            s3.calls = []

            await dest.saveMedia(meta('old.webm', 'aaa'), Promise.resolve(Buffer.from('aaa')))
            await dest.saveMedia(meta('new.webm', 'new'), Promise.resolve(Buffer.from('new')))
            await dest.saveMedia(meta('dup.webm', 'new'), Promise.resolve(Buffer.from('new')))

            const uploads = s3.callsTo('putObject')
            assert.equal(uploads.length, 1)
            assert.match(uploads[0].key!, /^wsg\/new_\d+\.webm$/)
            assert.equal(uploads[0].args.ACL, 'public-read')
        })

        it('records uploads in the manifest on close, so the next run needs no downloads', async () => {
            const {dest, s3} = make()
            await dest.getExistingMeta()
            await dest.saveMedia(meta('new.webm', 'new'), Promise.resolve(Buffer.from('new')))
            await dest.close()

            assert.deepEqual(savedManifest(s3).map(x => x.md5), [md5('new')])

            s3.calls = []
            const existing = await make({requireManifest: true}, s3).dest.getExistingMeta()
            assert.deepEqual(existing.map(x => x.md5), [md5('new')])
            assert.equal(s3.callsTo('getObject').filter(x => x.key !== manifestKey).length, 0)
        })

        it('publishes an index of every object on close, including ones uploaded this run', async () => {
            const {dest, s3} = make()
            s3.seed('wsg/old.webm', 'old')
            await dest.getExistingMeta()
            await dest.saveMedia(meta('new.webm', 'new'), Promise.resolve(Buffer.from('new')), 'new_1.webm')
            await dest.close()

            const published = JSON.parse(s3.objects.get('wsg/' + INDEX_FILENAME)!.body.toString())
            assert.deepEqual(published, {version: 1, files: ['new_1.webm', 'old.webm']})
        })

        it('refuses to overwrite an object when the generated name collides', async () => {
            const {dest, s3} = make()
            await dest.getExistingMeta()
            s3.seed('wsg/fixed.webm', 'existing')
            const fake = await import('../FileUtils.js')
            mock.method(fake.default, 'getUniqueName', () => 'fixed.webm')
            const fresh = make({}, s3).dest

            await assert.rejects(fresh.saveMedia(meta('x.webm', 'other'), Promise.resolve(Buffer.from('other'))), /collides/)
        })

        it('uploads under the requested filename when one is given', async () => {
            const {dest, s3} = make()
            await dest.getExistingMeta()

            await dest.saveMedia(meta('new.webm', 'new'), Promise.resolve(Buffer.from('new')), 'chosen_123.webm')

            assert.equal(s3.objects.has('wsg/chosen_123.webm'), true)
        })

        it('refuses unsafe requested filenames', async () => {
            const {dest} = make()
            await dest.getExistingMeta()
            for (const bad of ['../x.webm', 'sub/x.webm', MANIFEST_FILENAME, INDEX_FILENAME]) {
                await assert.rejects(
                    dest.saveMedia(meta('new.webm', 'new'), Promise.resolve(Buffer.from('new')), bad),
                    /unsafe filename/)
            }
        })

        it('still refuses unsupported file types', async () => {
            const {dest} = make()
            await dest.getExistingMeta()
            await assert.rejects(
                dest.saveMedia(new FileMeta('a.exe', 'a.exe', '.exe', 'h'), Promise.resolve(Buffer.from('x'))),
                /Unsupported extension/)
        })
    })
})
