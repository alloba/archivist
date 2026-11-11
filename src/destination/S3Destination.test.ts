import {describe, it, mock} from 'node:test'
import assert from 'node:assert/strict'
import S3Destination from './S3Destination.js'
import FileMeta from '../model/FileMeta.js'

mock.method(console, 'log', () => undefined)

const makeDest = (pages: any[]) => {
    const dest = new S3Destination({region: 'us-east-1', bucket: 'b', path: 'wsg'})
    const puts: any[] = []
    let page = 0
    dest.s3 = {
        listObjectsV2: async () => pages[page++],
        putObject: async (x: any) => {
            puts.push(x)
        },
    } as any
    return {dest, puts}
}

const meta = (name: string, md5: string) => new FileMeta(name, name, '.webm', md5)

describe('S3Destination', () => {
    it('reads md5 from ETags across paginated listings', async () => {
        const {dest} = makeDest([
            {Contents: [{Key: 'wsg/a.webm', ETag: '"h1"'}], IsTruncated: true, NextContinuationToken: 't'},
            {Contents: [{Key: 'wsg/b.webm', ETag: '"h2"'}], IsTruncated: false},
        ])

        const existing = await dest.getExistingMeta()

        assert.deepEqual(existing.map(x => x.md5), ['h1', 'h2'])
    })

    it('skips files that already exist and uploads ones that do not', async () => {
        const {dest, puts} = makeDest([{Contents: [{Key: 'wsg/a.webm', ETag: '"h1"'}], IsTruncated: false}])

        await dest.saveMedia(meta('old.webm', 'h1'), Promise.resolve(Buffer.from('x')))
        await dest.saveMedia(meta('new.webm', 'h2'), Promise.resolve(Buffer.from('y')))

        assert.equal(puts.length, 1)
        assert.match(puts[0].Key, /^wsg\/new_\d+\.webm$/)
    })

    it('does not upload the same content twice in one run', async () => {
        const {dest, puts} = makeDest([{Contents: [], IsTruncated: false}])

        await dest.saveMedia(meta('one.webm', 'dup'), Promise.resolve(Buffer.from('x')))
        await dest.saveMedia(meta('two.webm', 'dup'), Promise.resolve(Buffer.from('x')))

        assert.equal(puts.length, 1)
    })
})
