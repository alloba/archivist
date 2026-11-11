import {afterEach, beforeEach, describe, it, mock} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import FileSystemDestination from './FileSystemDestination.js'
import FileUtils from '../FileUtils.js'
import FileMeta from '../model/FileMeta.js'
import {MANIFEST_FILENAME, readManifest, TEMP_SUFFIX} from './FileManifest.js'

mock.method(console, 'log', () => undefined)
mock.method(console, 'error', () => undefined)

describe('FileSystemDestination', () => {
    let dir: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-fs-'))
    })
    afterEach(() => {
        mock.restoreAll()
        mock.method(console, 'log', () => undefined)
        mock.method(console, 'error', () => undefined)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content)
    const md5 = (content: string) => FileUtils.getMd5(Buffer.from(content))
    const meta = (name: string, content: string) => new FileMeta(name, name, path.extname(name), md5(content))
    const newDest = (extra: object = {}) => new FileSystemDestination({path: dir, ...extra})

    describe('scanning', () => {
        it('hashes existing files and writes a manifest', async () => {
            write('a.webm', 'aaa')
            write('b.webm', 'bbb')

            const existing = await newDest().getExistingMeta()

            assert.deepEqual(existing.map(x => x.md5).sort(), [md5('aaa'), md5('bbb')].sort())
            const manifest = await readManifest(dir)
            assert.equal(manifest?.length, 2)
        })

        it('ignores the manifest, temp files and subdirectories', async () => {
            write('a.webm', 'aaa')
            write('half-written.webm' + TEMP_SUFFIX, 'xxx')
            fs.mkdirSync(path.join(dir, 'subfolder'))
            const dest = newDest()
            await dest.getExistingMeta() // creates the manifest

            const existing = await dest.getExistingMeta()

            assert.deepEqual(existing.map(x => x.name), ['a.webm'])
        })

        it('does not re-hash unchanged files on later runs', async () => {
            write('a.webm', 'aaa')
            write('b.webm', 'bbb')
            await newDest().getExistingMeta()

            const spy = mock.method(FileUtils, 'getMd5OfFile')
            const existing = await newDest().getExistingMeta()

            assert.equal(spy.mock.callCount(), 0)
            assert.equal(existing.length, 2)
        })

        it('hashes only new files', async () => {
            write('a.webm', 'aaa')
            await newDest().getExistingMeta()
            write('b.webm', 'bbb')

            const spy = mock.method(FileUtils, 'getMd5OfFile')
            const existing = await newDest().getExistingMeta()

            assert.equal(spy.mock.callCount(), 1)
            assert.equal(existing.length, 2)
        })

        it('re-hashes a file whose size changed', async () => {
            write('a.webm', 'aaa')
            await newDest().getExistingMeta()
            write('a.webm', 'a longer replacement')

            const existing = await newDest().getExistingMeta()

            assert.deepEqual(existing.map(x => x.md5), [md5('a longer replacement')])
        })

        it('re-hashes a file whose mtime changed but size did not', async () => {
            write('a.webm', 'aaa')
            await newDest().getExistingMeta()
            write('a.webm', 'zzz')
            const future = new Date(Date.now() + 60_000)
            fs.utimesSync(path.join(dir, 'a.webm'), future, future)

            const existing = await newDest().getExistingMeta()

            assert.deepEqual(existing.map(x => x.md5), [md5('zzz')])
        })

        it('re-hashes everything when rebuild is set', async () => {
            write('a.webm', 'aaa')
            write('b.webm', 'bbb')
            await newDest().getExistingMeta()

            const spy = mock.method(FileUtils, 'getMd5OfFile')
            await newDest({rebuild: true}).getExistingMeta()

            assert.equal(spy.mock.callCount(), 2)
        })

        it('drops manifest entries for files that were deleted', async () => {
            write('a.webm', 'aaa')
            write('b.webm', 'bbb')
            await newDest().getExistingMeta()
            fs.rmSync(path.join(dir, 'b.webm'))

            const existing = await newDest().getExistingMeta()

            assert.deepEqual(existing.map(x => x.name), ['a.webm'])
            assert.deepEqual((await readManifest(dir))?.map(x => x.name), ['a.webm'])
        })

        it('tracks every file when several share the same content', async () => {
            write('a.webm', 'same')
            write('b.webm', 'same')
            await newDest().getExistingMeta()

            const spy = mock.method(FileUtils, 'getMd5OfFile')
            const existing = await newDest().getExistingMeta()

            assert.equal(spy.mock.callCount(), 0)
            assert.equal(existing.length, 2)
        })
    })

    describe('saving', () => {
        it('saves a new file and records it in the manifest', async () => {
            const dest = newDest()
            await dest.getExistingMeta()

            await dest.saveMedia(meta('new.webm', 'content'), Promise.resolve(Buffer.from('content')))
            await dest.close()

            const files = fs.readdirSync(dir).filter(x => x !== MANIFEST_FILENAME)
            assert.equal(files.length, 1)
            assert.match(files[0], /^new_\d+\.webm$/)
            assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), 'content')
            assert.deepEqual((await readManifest(dir))?.map(x => x.md5), [md5('content')])
        })

        it('does not leave temp files behind', async () => {
            const dest = newDest()
            await dest.saveMedia(meta('new.webm', 'content'), Promise.resolve(Buffer.from('content')))
            await dest.close()

            assert.equal(fs.readdirSync(dir).filter(x => x.endsWith(TEMP_SUFFIX)).length, 0)
        })

        it('skips files whose hash already exists, without waiting on the download', async () => {
            write('a.webm', 'aaa')
            const dest = newDest()
            await dest.getExistingMeta()
            const before = fs.readdirSync(dir).sort()

            const neverResolves = new Promise<Buffer>(() => undefined) // the test would hang if this were awaited
            await dest.saveMedia(meta('other.webm', 'aaa'), neverResolves)
            await dest.close()

            assert.deepEqual(fs.readdirSync(dir).sort(), before)
        })

        it('does not save the same content twice in one run', async () => {
            const dest = newDest()
            await dest.getExistingMeta()

            await dest.saveMedia(meta('one.webm', 'dup'), Promise.resolve(Buffer.from('dup')))
            await dest.saveMedia(meta('two.webm', 'dup'), Promise.resolve(Buffer.from('dup')))
            await dest.close()

            assert.equal(fs.readdirSync(dir).filter(x => x !== MANIFEST_FILENAME).length, 1)
        })

        it('is picked up by the next run without hashing anything', async () => {
            const dest = newDest()
            await dest.getExistingMeta()
            await dest.saveMedia(meta('new.webm', 'content'), Promise.resolve(Buffer.from('content')))
            await dest.close()

            const spy = mock.method(FileUtils, 'getMd5OfFile')
            const existing = await newDest().getExistingMeta()

            assert.equal(spy.mock.callCount(), 0)
            assert.deepEqual(existing.map(x => x.md5), [md5('content')])
        })

        it('refuses to overwrite when the generated name collides', async () => {
            mock.method(FileUtils, 'getUniqueName', () => 'fixed.webm')
            const dest = newDest()
            await dest.saveMedia(meta('one.webm', 'one'), Promise.resolve(Buffer.from('one')))

            await assert.rejects(
                dest.saveMedia(meta('two.webm', 'two'), Promise.resolve(Buffer.from('two'))),
                /collides/)
            assert.equal(fs.readFileSync(path.join(dir, 'fixed.webm'), 'utf8'), 'one')
        })
    })

    describe('failing loudly', () => {
        it('throws when the folder does not exist', async () => {
            const dest = new FileSystemDestination({path: path.join(dir, 'missing')})
            await assert.rejects(dest.getExistingMeta(), /does not exist/)
        })

        it('throws on requireManifest when no manifest exists', async () => {
            const dest = newDest({requireManifest: true})
            await assert.rejects(dest.getExistingMeta(), /requireManifest/)
            assert.equal(fs.existsSync(path.join(dir, MANIFEST_FILENAME)), false)
        })

        it('accepts requireManifest as the string "true" and when a manifest exists', async () => {
            await newDest().getExistingMeta() // initializes the manifest
            await assert.doesNotReject(newDest({requireManifest: 'true'}).getExistingMeta())
        })

        it('refuses to save when requireManifest fails, rather than writing into the folder', async () => {
            const dest = newDest({requireManifest: true})
            await assert.rejects(dest.saveMedia(meta('a.webm', 'a'), Promise.resolve(Buffer.from('a'))))
            assert.deepEqual(fs.readdirSync(dir), [])
        })

        it('throws on a corrupt manifest instead of silently ignoring it', async () => {
            write(MANIFEST_FILENAME, '{not json')
            await assert.rejects(newDest().getExistingMeta(), /not valid JSON/)
        })

        it('throws on a manifest with an unknown format', async () => {
            write(MANIFEST_FILENAME, JSON.stringify({version: 2, files: []}))
            await assert.rejects(newDest().getExistingMeta(), /unrecognized format/)
        })

        it('throws on a manifest with malformed entries', async () => {
            write(MANIFEST_FILENAME, JSON.stringify({version: 1, files: [{name: 'a'}]}))
            await assert.rejects(newDest().getExistingMeta(), /malformed/)
        })
    })
})
