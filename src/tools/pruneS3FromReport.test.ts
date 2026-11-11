import {afterEach, beforeEach, describe, it, mock} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {parseReport, pruneS3, Report} from './pruneS3FromReport.js'
import S3Backing from '../hashindex/S3Backing.js'
import FakeS3 from '../testing/FakeS3.js'
import {INDEX_FILENAME, MANIFEST_FILENAME, serializeIndex, serializeManifest} from '../hashindex/HashIndex.js'

mock.method(console, 'log', () => undefined)
mock.method(console, 'warn', () => undefined)

const member = (name: string, content: string) => ({path: name, size: content.length})

describe('pruneS3FromReport', () => {
    let nas: string
    let s3: FakeS3

    beforeEach(() => {
        nas = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-prune-'))
        s3 = new FakeS3()
        addLocation('wsg')
    })
    afterEach(() => {
        fs.rmSync(nas, {recursive: true, force: true})
    })

    /** A NAS subfolder with a manifest, as archivist leaves it. */
    function addLocation(name: string, withManifest = true) {
        fs.mkdirSync(path.join(nas, name), {recursive: true})
        if (withManifest) {
            fs.writeFileSync(path.join(nas, name, MANIFEST_FILENAME), serializeManifest([]))
        }
    }

    const onNas = (name: string, content: string) => fs.writeFileSync(path.join(nas, name), content)
    const inS3 = (name: string, content: string) => s3.seed(name, content)
    const run = (report: Report, apply = true, basePrefix = '') =>
        pruneS3(report, nas, {getClient: () => s3 as any, bucket: 'b', basePrefix}, {apply})
    const s3Names = () => [...s3.objects.keys()].sort()

    const duplicateReport = (): Report => ({
        video: [[member('wsg/keep.mp4', 'KEEPER'), member('wsg/dupe.mp4', 'dupe')]], audio: [], unreadable: []
    })

    it('deletes from S3 a duplicate that is gone from the NAS, and leaves the keeper', async () => {
        onNas('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/dupe.mp4', 'dupe')

        const result = await run(duplicateReport())

        assert.deepEqual(result.deleted, ['wsg/dupe.mp4'])
        assert.deepEqual(s3Names(), ['wsg/keep.mp4'])
    })

    it('handles several subfolders, each with its own manifest and index', async () => {
        addLocation('g')
        onNas('wsg/keep.mp4', 'KEEPER')
        onNas('g/keep.mp4', 'KEEPER-G')
        for (const [loc, keeper, dupe] of [['wsg', 'KEEPER', 'dupe'], ['g', 'KEEPER-G', 'dupe-g']]) {
            inS3(`${loc}/keep.mp4`, keeper)
            inS3(`${loc}/dupe.mp4`, dupe)
            const entry = (name: string, content: string) => ({name, md5: 'x', size: content.length, mtimeMs: 1})
            const backing = new S3Backing(() => s3 as any, 'b', loc + '/')
            await backing.writeManifest([entry('keep.mp4', keeper), entry('dupe.mp4', dupe)])
            await backing.writeIndex(['dupe.mp4', 'keep.mp4'])
        }
        const report: Report = {
            video: [
                [member('wsg/keep.mp4', 'KEEPER'), member('wsg/dupe.mp4', 'dupe')],
                [member('g/keep.mp4', 'KEEPER-G'), member('g/dupe.mp4', 'dupe-g')]],
            audio: [], unreadable: []
        }

        const result = await run(report)

        assert.deepEqual(result.deleted.sort(), ['g/dupe.mp4', 'wsg/dupe.mp4'])
        for (const loc of ['wsg', 'g']) {
            const backing = new S3Backing(() => s3 as any, 'b', loc + '/')
            assert.deepEqual((await backing.readManifest())!.map(x => x.name), ['keep.mp4'])
            assert.deepEqual(JSON.parse(s3.objects.get(`${loc}/${INDEX_FILENAME}`)!.body.toString()).files, ['keep.mp4'])
        }
    })

    it('skips a subfolder that has no manifest, and reports it', async () => {
        addLocation('g', false)
        onNas('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/dupe.mp4', 'dupe')
        inS3('g/dupe.mp4', 'dupe-g')
        const report: Report = {
            video: [
                [member('wsg/keep.mp4', 'KEEPER'), member('wsg/dupe.mp4', 'dupe')],
                [member('g/keep.mp4', 'KEEPER-G'), member('g/dupe.mp4', 'dupe-g')]],
            audio: [], unreadable: []
        }

        const result = await run(report)

        assert.deepEqual(result.deleted, ['wsg/dupe.mp4'])
        assert.deepEqual(result.skippedLocations, ['g'])
        assert.ok(s3.objects.has('g/dupe.mp4'))
    })

    it('does not let a file in an unverified subfolder count as a surviving copy', async () => {
        addLocation('g', false)
        onNas('g/keep.mp4', 'KEEPER') // exists, but g has no manifest so it cannot be trusted
        inS3('wsg/dupe.mp4', 'dupe')
        const report: Report = {
            video: [[member('g/keep.mp4', 'KEEPER'), member('wsg/dupe.mp4', 'dupe')]], audio: [], unreadable: []
        }

        const result = await run(report)

        assert.deepEqual(result.deleted, [])
    })

    it('applies a base prefix to S3 keys', async () => {
        onNas('wsg/keep.mp4', 'KEEPER')
        inS3('media/wsg/keep.mp4', 'KEEPER')
        inS3('media/wsg/dupe.mp4', 'dupe')

        const result = await run(duplicateReport(), true, 'media/')

        assert.deepEqual(result.deleted, ['wsg/dupe.mp4'])
        assert.deepEqual(s3Names(), ['media/wsg/keep.mp4'])
    })

    it('does nothing on a dry run', async () => {
        onNas('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/dupe.mp4', 'dupe')

        const result = await run(duplicateReport(), false)

        assert.deepEqual(result.plan.toDelete.map(x => x.name), ['wsg/dupe.mp4'])
        assert.equal(s3.callsTo('deleteObjects').length, 0)
        assert.equal(s3Names().length, 2)
    })

    it('keeps a file that is still on the NAS', async () => {
        onNas('wsg/keep.mp4', 'KEEPER')
        onNas('wsg/dupe.mp4', 'dupe')
        inS3('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/dupe.mp4', 'dupe')

        const result = await run(duplicateReport())

        assert.deepEqual(result.deleted, [])
        assert.equal(s3Names().length, 2)
    })

    it('never removes the last surviving copy: if no group member is on the NAS, nothing is deleted', async () => {
        inS3('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/dupe.mp4', 'dupe')

        const result = await run(duplicateReport())

        assert.deepEqual(result.deleted, [])
        assert.equal(s3Names().length, 2)
    })

    it('leaves an S3 object alone if its size is not what was scanned', async () => {
        onNas('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/dupe.mp4', 'a different, longer file')

        const result = await run(duplicateReport())

        assert.deepEqual(result.deleted, [])
        assert.ok(s3.objects.has('wsg/dupe.mp4'))
    })

    it('leaves a NAS file with a changed size alone, and does not count it as a survivor', async () => {
        onNas('wsg/keep.mp4', 'KEEPER but edited since the scan')
        inS3('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/dupe.mp4', 'dupe')

        const result = await run(duplicateReport())

        assert.deepEqual(result.deleted, [])
    })

    it('never touches S3 objects that are not in the report, even if the NAS lacks them', async () => {
        onNas('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/dupe.mp4', 'dupe')
        inS3('wsg/unrelated.mp4', 'not mentioned anywhere')

        await run(duplicateReport())

        assert.ok(s3.objects.has('wsg/unrelated.mp4'))
    })

    it('deletes unreadable files that are gone from the NAS', async () => {
        inS3('wsg/broken.mp4', 'xx')

        const result = await run({video: [], audio: [], unreadable: [member('wsg/broken.mp4', 'xx')]})

        assert.deepEqual(result.deleted, ['wsg/broken.mp4'])
    })

    it('refuses to run when no NAS subfolder has a manifest (e.g. an unmounted share)', async () => {
        fs.rmSync(path.join(nas, 'wsg', MANIFEST_FILENAME))
        inS3('wsg/broken.mp4', 'xx')

        await assert.rejects(run({video: [], audio: [], unreadable: [member('wsg/broken.mp4', 'xx')]}), /No \.archivist-manifest\.json/)
        assert.ok(s3.objects.has('wsg/broken.mp4'))
    })

    it('rejects report paths that escape the folder', async () => {
        await assert.rejects(run({video: [], audio: [], unreadable: [member('wsg/../../outside.mp4', 'x')]}), /escapes/)
    })

    it('does not create an index if the location never had one', async () => {
        onNas('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/keep.mp4', 'KEEPER')
        inS3('wsg/dupe.mp4', 'dupe')

        await run(duplicateReport())

        assert.ok(!s3.objects.has('wsg/' + INDEX_FILENAME))
    })

    it('parseReport rejects things that are not a report', () => {
        assert.throws(() => parseReport('not json'), /not valid JSON/)
        assert.throws(() => parseReport(serializeIndex(['a'])), /not a find_similar_media/)
        assert.doesNotThrow(() => parseReport(JSON.stringify({video: [], audio: [], unreadable: []})))
    })
})
