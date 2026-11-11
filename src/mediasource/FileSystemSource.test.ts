import {afterEach, beforeEach, describe, it, mock} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import FileSystemSource from './FileSystemSource.js'
import FileUtils from '../FileUtils.js'
import {MANIFEST_FILENAME} from '../hashindex/HashIndex.js'

mock.method(console, 'log', () => undefined)
mock.method(console, 'warn', () => undefined)

describe('FileSystemSource', () => {
    let dir: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-src-'))
    })
    afterEach(() => {
        mock.restoreAll()
        mock.method(console, 'log', () => undefined)
        mock.method(console, 'warn', () => undefined)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content)
    const md5 = (content: string) => FileUtils.getMd5(Buffer.from(content))
    const make = (extra: object = {}) => new FileSystemSource({path: dir, ...extra})

    it('returns metadata for files, and saves a manifest in the folder', async () => {
        write('a.webm', 'aaa')

        const metas = await make().scanForMetadata()

        assert.equal(metas.length, 1)
        assert.equal(metas[0].name, 'a.webm')
        assert.equal(metas[0].extension, '.webm')
        assert.equal(metas[0].md5, md5('aaa'))
        assert.equal(metas[0].uri, path.resolve(dir, 'a.webm'))
        assert.equal(fs.existsSync(path.join(dir, MANIFEST_FILENAME)), true)
    })

    it('does not re-hash unchanged files on later scans', async () => {
        write('a.webm', 'aaa')
        await make().scanForMetadata()

        const spy = mock.method(FileUtils, 'getMd5OfFile')
        const metas = await make().scanForMetadata()

        assert.equal(spy.mock.callCount(), 0)
        assert.equal(metas.length, 1)
    })

    it('skips the manifest, subfolders and files without an extension', async () => {
        write('a.webm', 'aaa')
        write('noextension', 'zzz')
        fs.mkdirSync(path.join(dir, 'sub.folder'))
        await make().scanForMetadata() // creates the manifest

        const metas = await make().scanForMetadata()

        assert.deepEqual(metas.map(x => x.name), ['a.webm'])
    })

    it('still scans if the folder is read-only for the manifest', async () => {
        write('a.webm', 'aaa')
        fs.mkdirSync(path.join(dir, MANIFEST_FILENAME + '.archivist-tmp')) // makes the atomic write fail

        const metas = await make().scanForMetadata()

        assert.equal(metas.length, 1)
    })

    it('supports requireManifest and rebuild', async () => {
        write('a.webm', 'aaa')
        await assert.rejects(make({requireManifest: true}).scanForMetadata(), /requireManifest/)

        await make().scanForMetadata()
        const spy = mock.method(FileUtils, 'getMd5OfFile')
        await make({rebuild: true}).scanForMetadata()
        assert.equal(spy.mock.callCount(), 1)
    })

    it('fails when the folder does not exist', async () => {
        await assert.rejects(new FileSystemSource({path: path.join(dir, 'missing')}).scanForMetadata(), /does not exist/)
    })

    it('downloads file contents', async () => {
        write('a.webm', 'aaa')
        const [meta] = await make().scanForMetadata()

        assert.equal((await make().downloadFile(meta)).toString(), 'aaa')
    })
})
