import {describe, it, mock} from 'node:test'
import assert from 'node:assert/strict'
import {archive} from './archive.js'
import FileMeta from './model/FileMeta.js'
import {DestinationInterface} from './destination/DestinationInterface.js'
import {SourceInterface} from './mediasource/SourceInterface.js'
import FileSystemDestination from './destination/FileSystemDestination.js'
import S3Destination from './destination/S3Destination.js'
import FakeS3 from './testing/FakeS3.js'
import FileUtils from './FileUtils.js'
import fs from 'fs'
import os from 'os'
import path from 'path'

mock.method(console, 'log', () => undefined)
mock.method(console, 'error', () => undefined)

const file = (name: string, md5: string) => new FileMeta(name, name, '.webm', md5)

class FakeSource implements SourceInterface {
    downloads: string[] = []

    constructor(public files: FileMeta[], public scanError?: Error) {
    }

    async scanForMetadata() {
        if (this.scanError) throw this.scanError
        return this.files
    }

    async downloadFile(m: FileMeta) {
        this.downloads.push(m.name)
        return Buffer.from(m.name)
    }
}

class FakeDestination implements DestinationInterface {
    saved: string[] = []
    savedAs: string[] = [] // the filename each saved file was given
    closed = 0

    constructor(public existingHashes: string[] = [], public failOn: string[] = [], public existingError?: Error) {
    }

    async getExistingMeta() {
        if (this.existingError) throw this.existingError
        return this.existingHashes.map(x => file('existing', x))
    }

    async saveMedia(m: FileMeta, raw: Promise<Buffer>, filename?: string) {
        await raw
        if (this.failOn.includes(m.name)) throw Error('boom ' + m.name)
        this.saved.push(m.name)
        this.savedAs.push(filename ?? '')
    }

    async close() {
        this.closed++
    }
}

describe('archive', () => {
    const files = [file('a', 'h1'), file('b', 'h2'), file('c', 'h3')]

    it('saves every file to every destination that lacks it', async () => {
        const dest1 = new FakeDestination()
        const dest2 = new FakeDestination()

        await archive(new FakeSource(files), [dest1, dest2], {serious: true})

        assert.deepEqual(dest1.saved, ['a', 'b', 'c'])
        assert.deepEqual(dest2.saved, ['a', 'b', 'c'])
    })

    it('decides uniqueness per destination', async () => {
        const hasA = new FakeDestination(['h1'])
        const hasBC = new FakeDestination(['h2', 'h3'])

        await archive(new FakeSource(files), [hasA, hasBC], {serious: true})

        assert.deepEqual(hasA.saved, ['b', 'c'])
        assert.deepEqual(hasBC.saved, ['a'])
    })

    it('downloads each file once regardless of destination count, and skips files nobody needs', async () => {
        const source = new FakeSource(files)
        const dest1 = new FakeDestination(['h1', 'h2'])
        const dest2 = new FakeDestination(['h1'])

        await archive(source, [dest1, dest2], {serious: true})

        assert.deepEqual(source.downloads.sort(), ['b', 'c'])
    })

    it('does nothing when every destination is already up to date', async () => {
        const source = new FakeSource(files)
        const dest = new FakeDestination(['h1', 'h2', 'h3'])

        const result = await archive(source, [dest], {serious: true})

        assert.equal(result.saveAttempts, 0)
        assert.deepEqual(source.downloads, [])
    })

    it('without serious, saves and downloads nothing but still closes destinations', async () => {
        const source = new FakeSource(files)
        const dest = new FakeDestination()

        await archive(source, [dest], {serious: false})

        assert.deepEqual(dest.saved, [])
        assert.deepEqual(source.downloads, [])
        assert.equal(dest.closed, 1)
    })

    it('closes every destination after a successful run', async () => {
        const dest1 = new FakeDestination()
        const dest2 = new FakeDestination()

        await archive(new FakeSource(files), [dest1, dest2], {serious: true})

        assert.equal(dest1.closed, 1)
        assert.equal(dest2.closed, 1)
    })

    it('fails the run when a destination cannot be read, before saving anywhere', async () => {
        const healthy = new FakeDestination()
        const broken = new FakeDestination([], [], Error('share not mounted'))

        await assert.rejects(archive(new FakeSource(files), [healthy, broken], {serious: true}), /share not mounted/)

        assert.deepEqual(healthy.saved, [])
        assert.equal(healthy.closed, 1)
    })

    it('fails the run when the source cannot be scanned', async () => {
        const dest = new FakeDestination()

        await assert.rejects(archive(new FakeSource([], Error('source down')), [dest], {serious: true}), /source down/)

        assert.equal(dest.closed, 1)
    })

    it('a failed save fails the run, but the other destination and remaining files still get saved', async () => {
        const healthy = new FakeDestination()
        const flaky = new FakeDestination([], ['b'])

        await assert.rejects(archive(new FakeSource(files), [flaky, healthy], {serious: true}), /boom b/)

        assert.deepEqual(healthy.saved, ['a', 'b', 'c'])
        assert.deepEqual(flaky.saved, ['a', 'c'])
        assert.equal(flaky.closed, 1)
        assert.equal(healthy.closed, 1)
    })

    it('a failing close fails the run', async () => {
        const dest = new FakeDestination()
        dest.close = async () => {
            throw Error('manifest write failed')
        }

        await assert.rejects(archive(new FakeSource(files), [dest], {serious: true}), /manifest write failed/)
    })

    it('a failed download is reported rather than crashing as an unhandled rejection', async () => {
        const source = new FakeSource(files)
        source.downloadFile = async (m: FileMeta) => {
            if (m.name === 'b') throw Error('download failed')
            return Buffer.from(m.name)
        }
        const dest = new FakeDestination()

        await assert.rejects(archive(source, [dest], {serious: true}), /download failed/)

        assert.deepEqual(dest.saved, ['a', 'c'])
    })
})

describe('archive filenames across destinations', () => {
    const files = [file('a.webm', 'h1'), file('b.webm', 'h2')]

    it('gives every destination the same filename for a file, and different names to different files', async () => {
        const dest1 = new FakeDestination()
        const dest2 = new FakeDestination()

        await archive(new FakeSource(files), [dest1, dest2], {serious: true})

        assert.deepEqual(dest1.savedAs, dest2.savedAs)
        assert.equal(dest1.savedAs.length, 2)
        assert.notEqual(dest1.savedAs[0], dest1.savedAs[1])
        assert.match(dest1.savedAs[0], /^a_\d+\.webm$/)
    })

    it('uses the same name even when destinations save at different moments', async () => {
        const names: string[] = []
        const slow = new FakeDestination()
        const slowSave = slow.saveMedia.bind(slow)
        slow.saveMedia = async (m, raw, filename) => {
            await new Promise(resolve => setTimeout(resolve, 20)) // would produce a different timestamp
            names.push(filename!)
            return slowSave(m, raw, filename)
        }
        const fast = new FakeDestination()

        await archive(new FakeSource([file('a.webm', 'h1')]), [slow, fast], {serious: true})

        assert.deepEqual(names, fast.savedAs)
    })

    it('only generates the name for files that some destination needs', async () => {
        const spy = mock.method(FileUtils, 'getUniqueName')
        const dest = new FakeDestination(['h1'])

        await archive(new FakeSource(files), [dest], {serious: true})

        assert.equal(spy.mock.callCount(), 1)
        mock.restoreAll()
        mock.method(console, 'log', () => undefined)
        mock.method(console, 'error', () => undefined)
    })

    it('real destinations end up with identical filenames (S3 and a folder)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-names-'))
        try {
            const s3 = new FakeS3()
            const s3dest = new S3Destination({region: 'us-east-1', bucket: 'b', path: 'wsg'})
            s3dest.s3 = s3 as any
            const fsdest = new FileSystemDestination({path: dir})
            // distinct content per file, with real hashes so nothing is considered a duplicate
            const content = ['first', 'second', 'third']
            const metas = content.map((c, i) => new FileMeta(`clip${i}.webm`, `clip${i}.webm`, '.webm', FileUtils.getMd5(Buffer.from(c))))
            const source: SourceInterface = {
                scanForMetadata: async () => metas,
                downloadFile: async m => Buffer.from(content[metas.indexOf(m)])
            }

            await archive(source, [s3dest, fsdest], {serious: true})

            const s3Names = [...s3.objects.keys()].filter(k => !k.endsWith('.json')).map(k => k.replace('wsg/', '')).sort()
            const folderNames = fs.readdirSync(dir).filter(n => !n.endsWith('.json')).sort()
            assert.equal(s3Names.length, 3)
            assert.deepEqual(s3Names, folderNames)
        } finally {
            fs.rmSync(dir, {recursive: true, force: true})
        }
    })
})
