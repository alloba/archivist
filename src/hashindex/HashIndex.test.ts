import {afterEach, describe, it, mock} from 'node:test'
import assert from 'node:assert/strict'
import {
    HashIndex,
    IndexBacking,
    IndexOptions,
    indexOptionsFromArgs,
    ListedItem,
    ManifestEntry,
    parseManifest
} from './HashIndex.js'

mock.method(console, 'log', () => undefined)
mock.method(console, 'warn', () => undefined)

/** An in-memory location. Hashing is faked as `md5-of-<content>` and counted. */
class FakeBacking implements IndexBacking {
    manifest: ManifestEntry[] | null = null
    files = new Map<string, { content: string, mtimeMs: number, hintMd5?: string }>()
    hashed: string[] = []
    writes = 0
    unreachable = false
    failWrites = false

    describe() {
        return 'fake://location'
    }

    async assertReachable() {
        if (this.unreachable) throw Error('location unreachable')
    }

    async readManifest() {
        return this.manifest
    }

    async writeManifest(entries: ManifestEntry[]) {
        if (this.failWrites) throw Error('read-only')
        this.writes++
        this.manifest = entries
    }

    async list(): Promise<ListedItem[]> {
        return [...this.files].map(([name, f]) => ({name, size: f.content.length, mtimeMs: f.mtimeMs, hintMd5: f.hintMd5}))
    }

    async hash(item: ListedItem) {
        this.hashed.push(item.name)
        return 'md5-of-' + this.files.get(item.name)!.content
    }

    add(name: string, content: string, mtimeMs = 1000, hintMd5?: string) {
        this.files.set(name, {content, mtimeMs, hintMd5})
    }
}

const entry = (name: string, content: string, mtimeMs = 1000): ManifestEntry =>
    ({name, md5: 'md5-of-' + content, size: content.length, mtimeMs})

describe('HashIndex', () => {
    afterEach(() => {
        mock.restoreAll()
        mock.method(console, 'log', () => undefined)
        mock.method(console, 'warn', () => undefined)
    })

    const make = (backing: FakeBacking, options: IndexOptions = {}) => new HashIndex(backing, options)

    it('hashes everything on the first sync and saves a manifest', async () => {
        const backing = new FakeBacking()
        backing.add('a', 'aaa')
        backing.add('b', 'bbb')

        const index = make(backing)
        await index.sync()

        assert.deepEqual(backing.hashed.sort(), ['a', 'b'])
        assert.equal(backing.manifest?.length, 2)
        assert.equal(index.hasHash('md5-of-aaa'), true)
        assert.equal(index.hasHash('md5-of-zzz'), false)
    })

    it('only hashes new or changed files on later syncs', async () => {
        const backing = new FakeBacking()
        backing.add('a', 'aaa')
        backing.add('b', 'bbb')
        await make(backing).sync()
        backing.hashed = []
        backing.add('c', 'ccc') // new
        backing.add('b', 'bbbb', 2000) // changed

        await make(backing).sync()

        assert.deepEqual(backing.hashed.sort(), ['b', 'c'])
    })

    it('does not write the manifest when nothing changed', async () => {
        const backing = new FakeBacking()
        backing.add('a', 'aaa')
        await make(backing).sync()
        const writesAfterFirst = backing.writes

        await make(backing).sync()

        assert.equal(backing.writes, writesAfterFirst)
    })

    it('drops entries for files that are gone', async () => {
        const backing = new FakeBacking()
        backing.add('a', 'aaa')
        backing.add('b', 'bbb')
        await make(backing).sync()
        backing.files.delete('b')

        const index = make(backing)
        await index.sync()

        assert.deepEqual(index.entries().map(x => x.name), ['a'])
        assert.deepEqual(backing.manifest?.map(x => x.name), ['a'])
    })

    it('rebuild hashes everything again', async () => {
        const backing = new FakeBacking()
        backing.add('a', 'aaa')
        await make(backing).sync()
        backing.hashed = []

        await make(backing, {rebuild: true}).sync()

        assert.deepEqual(backing.hashed, ['a'])
    })

    describe('hints', () => {
        it('are ignored by default', async () => {
            const backing = new FakeBacking()
            backing.add('a', 'aaa', 1000, 'hinted')

            const index = make(backing)
            await index.sync()

            assert.deepEqual(backing.hashed, ['a'])
            assert.equal(index.hasHash('hinted'), false)
        })

        it('are used for files with no cached entry when useHints is set', async () => {
            const backing = new FakeBacking()
            backing.add('a', 'aaa', 1000, 'hinted')
            backing.add('b', 'bbb') // no hint available

            const index = make(backing, {useHints: true})
            await index.sync()

            assert.deepEqual(backing.hashed, ['b'])
            assert.equal(index.hasHash('hinted'), true)
        })

        it('never override a valid cached entry', async () => {
            const backing = new FakeBacking()
            backing.manifest = [entry('a', 'aaa')]
            backing.add('a', 'aaa', 1000, 'different-hint')

            const index = make(backing, {useHints: true})
            await index.sync()

            assert.equal(index.hasHash('md5-of-aaa'), true)
            assert.equal(index.hasHash('different-hint'), false)
        })

        it('are ignored when rebuilding', async () => {
            const backing = new FakeBacking()
            backing.add('a', 'aaa', 1000, 'hinted')

            await make(backing, {useHints: true, rebuild: true}).sync()

            assert.deepEqual(backing.hashed, ['a'])
        })
    })

    describe('failing loudly', () => {
        it('propagates an unreachable location', async () => {
            const backing = new FakeBacking()
            backing.unreachable = true
            await assert.rejects(make(backing).sync(), /unreachable/)
        })

        it('requireManifest fails when there is no manifest, without hashing or writing anything', async () => {
            const backing = new FakeBacking()
            backing.add('a', 'aaa')

            await assert.rejects(make(backing, {requireManifest: true}).sync(), /requireManifest/)

            assert.deepEqual(backing.hashed, [])
            assert.equal(backing.writes, 0)
        })

        it('requireManifest passes when a manifest exists', async () => {
            const backing = new FakeBacking()
            backing.manifest = []
            await assert.doesNotReject(make(backing, {requireManifest: true}).sync())
        })

        it('fails when the manifest cannot be written', async () => {
            const backing = new FakeBacking()
            backing.add('a', 'aaa')
            backing.failWrites = true
            await assert.rejects(make(backing).sync(), /read-only/)
        })

        it('only warns when the manifest cannot be written and bestEffortWrite is set', async () => {
            const backing = new FakeBacking()
            backing.add('a', 'aaa')
            backing.failWrites = true

            const index = make(backing, {bestEffortWrite: true})
            await index.sync()

            assert.deepEqual(index.entries().map(x => x.name), ['a'])
        })

        it('refuses use before loading', () => {
            assert.throws(() => make(new FakeBacking()).hasHash('x'), /before it was loaded/)
        })
    })

    describe('recording saved files', () => {
        it('makes the file and the source hash known, and persists on flush', async () => {
            const backing = new FakeBacking()
            const index = make(backing)
            await index.sync()
            const writes = backing.writes

            index.record(entry('new', 'content'), 'source-claimed-hash')
            await index.flush()

            assert.equal(index.hasHash('md5-of-content'), true)
            assert.equal(index.hasHash('source-claimed-hash'), true)
            assert.equal(index.hasName('new'), true)
            assert.equal(backing.writes, writes + 1)
            assert.deepEqual(backing.manifest?.map(x => x.name), ['new'])
        })

        it('refuses to record a name that is already present', async () => {
            const backing = new FakeBacking()
            backing.add('a', 'aaa')
            const index = make(backing)
            await index.sync()

            assert.throws(() => index.record(entry('a', 'other')), /collides/)
        })
    })
})

describe('parseManifest', () => {
    it('accepts a valid manifest', () => {
        assert.deepEqual(parseManifest(JSON.stringify({version: 1, files: [entry('a', 'aaa')]}), 'x'), [entry('a', 'aaa')])
    })

    it('rejects bad JSON, unknown versions and malformed entries', () => {
        assert.throws(() => parseManifest('{nope', 'x'), /not valid JSON/)
        assert.throws(() => parseManifest(JSON.stringify({version: 2, files: []}), 'x'), /unrecognized format/)
        assert.throws(() => parseManifest(JSON.stringify({version: 1, files: [{name: 'a'}]}), 'x'), /malformed/)
    })
})

describe('indexOptionsFromArgs', () => {
    it('reads flags given as booleans or the string "true"', () => {
        assert.deepEqual(indexOptionsFromArgs({requireManifest: true, rebuild: 'true', seedFromEtag: true}),
            {requireManifest: true, rebuild: true, useHints: true, bestEffortWrite: false})
    })

    it('defaults everything off', () => {
        assert.deepEqual(indexOptionsFromArgs({}),
            {requireManifest: false, rebuild: false, useHints: false, bestEffortWrite: false})
        assert.equal(indexOptionsFromArgs(undefined, true).bestEffortWrite, true)
    })
})
