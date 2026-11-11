import {afterEach, beforeEach, describe, it, mock} from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {buildSeed, seedS3Manifest, SeedOptions} from './seedS3Manifest.js'
import S3Backing from '../hashindex/S3Backing.js'
import FileSystemBacking from '../hashindex/FileSystemBacking.js'
import FakeS3 from '../testing/FakeS3.js'
import {ListedItem, MANIFEST_FILENAME, ManifestEntry} from '../hashindex/HashIndex.js'

mock.method(console, 'log', () => undefined)

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')
const item = (name: string, content: string, mtimeMs = 5000, plainEtag = true): ListedItem =>
    ({name, size: content.length, mtimeMs, hintMd5: plainEtag ? md5(content) : undefined})
const local = (name: string, content: string, mtimeMs = 5000): ManifestEntry =>
    ({name, md5: md5(content), size: content.length, mtimeMs})

describe('buildSeed', () => {
    it('seeds entries confirmed by ETag, using the S3 mtime rather than the folder mtime', () => {
        const report = buildSeed([item('a', 'aaa', 9000)], [local('a', 'aaa', 1234)])

        assert.deepEqual(report.entries, [{name: 'a', md5: md5('aaa'), size: 3, mtimeMs: 9000}])
        assert.equal(report.verifiedByEtag, 1)
    })

    it('excludes and reports an object whose ETag disagrees with the folder hash', () => {
        const report = buildSeed([item('a', 'aaa')], [{...local('a', 'aaa'), md5: md5('corrupted')}])

        assert.deepEqual(report.entries, [])
        assert.equal(report.hashConflicts.length, 1)
        assert.equal(report.hashConflicts[0].name, 'a')
    })

    it('excludes size mismatches, even when the hash would agree', () => {
        const report = buildSeed([item('a', 'aaa')], [{...local('a', 'aaa'), size: 99}])

        assert.deepEqual(report.sizeMismatch, ['a'])
        assert.deepEqual(report.entries, [])
    })

    it('without a plain ETag, trusts the folder only if the mtime matches (within a second)', () => {
        const report = buildSeed(
            [item('same', 'aaa', 5000, false), item('close', 'bbb', 5000, false), item('far', 'ccc', 5000, false)],
            [local('same', 'aaa', 5000), local('close', 'bbb', 5500), local('far', 'ccc', 99_000)])

        assert.deepEqual(report.entries.map(x => x.name), ['same', 'close'])
        assert.equal(report.trustedByMtime, 2)
        assert.deepEqual(report.unverifiable, ['far'])
    })

    it('reports objects missing from the folder, and folder files missing from S3', () => {
        const report = buildSeed([item('only-s3', 'x')], [local('only-folder', 'y')])

        assert.deepEqual(report.notInFolder, ['only-s3'])
        assert.deepEqual(report.folderOnly, ['only-folder'])
        assert.deepEqual(report.entries, [])
    })
})

describe('seedS3Manifest', () => {
    let dir: string
    let s3: FakeS3
    let s3Backing: S3Backing
    let folder: FileSystemBacking

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-seed-'))
        s3 = new FakeS3()
        s3Backing = new S3Backing(() => s3 as any, 'b', 'wsg/')
        folder = new FileSystemBacking(dir)
    })
    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true})
    })

    const options = (extra: Partial<SeedOptions> = {}): SeedOptions => ({write: true, overwrite: false, allowConflicts: false, ...extra})
    const writeFolderManifest = (entries: ManifestEntry[]) => folder.writeManifest(entries)
    const manifestKey = 'wsg/' + MANIFEST_FILENAME

    it('writes a manifest that a normal run then uses without downloading anything', async () => {
        s3.seed('wsg/a.webm', 'aaa')
        await writeFolderManifest([local('a.webm', 'aaa')])

        const report = await seedS3Manifest(s3Backing, folder, options())

        assert.equal(report.entries.length, 1)
        const {default: S3Source} = await import('../mediasource/S3Source.js')
        const source = new S3Source({region: 'us-east-1', bucket: 'b', path: 'wsg', requireManifest: true})
        source.s3 = s3 as any
        s3.calls = []
        const metas = await source.scanForMetadata()
        assert.deepEqual(metas.map(x => x.md5), [md5('aaa')])
        assert.equal(s3.callsTo('getObject').filter(x => x.key !== manifestKey).length, 0)
    })

    it('is a dry run unless asked to write', async () => {
        s3.seed('wsg/a.webm', 'aaa')
        await writeFolderManifest([local('a.webm', 'aaa')])

        const report = await seedS3Manifest(s3Backing, folder, options({write: false}))

        assert.equal(report.entries.length, 1)
        assert.equal(s3.callsTo('putObject').length, 0)
    })

    it('refuses to write when objects conflict with the folder, unless allowed', async () => {
        s3.seed('wsg/a.webm', 'aaa')
        s3.seed('wsg/b.webm', 'bbb')
        await writeFolderManifest([local('a.webm', 'aaa'), {...local('b.webm', 'bbb'), md5: md5('different')}])

        await assert.rejects(seedS3Manifest(s3Backing, folder, options()), /disagree/)
        assert.equal(s3.callsTo('putObject').length, 0)

        const report = await seedS3Manifest(s3Backing, folder, options({allowConflicts: true}))
        assert.deepEqual(report.entries.map(x => x.name), ['a.webm'])
        assert.equal(s3.callsTo('putObject').length, 1)
    })

    it('refuses to replace an existing S3 manifest unless told to', async () => {
        s3.seed('wsg/a.webm', 'aaa')
        await writeFolderManifest([local('a.webm', 'aaa')])
        await seedS3Manifest(s3Backing, folder, options())

        await assert.rejects(seedS3Manifest(s3Backing, folder, options()), /already exists/)
        await assert.doesNotReject(seedS3Manifest(s3Backing, folder, options({overwrite: true})))
    })

    it('requires the folder to have been hashed already', async () => {
        await assert.rejects(seedS3Manifest(s3Backing, folder, options()), /no \.archivist-manifest\.json/)
    })
})
