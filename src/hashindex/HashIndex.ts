/**
 * A hash index is a cache of md5 hashes for the files in one location (a folder, or an S3 prefix), persisted as a
 * manifest, `.archivist-manifest.json`, stored in that same location.
 *
 * Every source and destination goes through this, so they all behave the same way:
 * - The location is listed (cheap: names, sizes and modification times only).
 * - Entries in the manifest are trusted while name, size and mtime still match the listing.
 * - Only files that are new or changed get hashed (by reading them).
 * - The manifest is persisted if anything changed.
 *
 * The manifest is purely a cache. It can be deleted at any time and will be rebuilt by the next scan.
 * Where and how things are actually read/written is up to an `IndexBacking`.
 */
export const MANIFEST_FILENAME = '.archivist-manifest.json'

/**
 * A public-facing listing of the location, `.archivist-index.json`, stored beside the manifest. Unlike the manifest
 * (a private cache of hashes that only archivist reads), this is meant for other consumers, e.g. a web page that wants
 * the list of files without paging through an S3 listing. It holds file names only, relative to the location.
 */
export const INDEX_FILENAME = '.archivist-index.json'

/** Suffix for files that are still being written. Scans ignore these. */
export const TEMP_SUFFIX = '.archivist-tmp'

export interface ManifestEntry {
    /** Path relative to the indexed location. */
    name: string
    md5: string
    size: number
    mtimeMs: number
}

export interface ListedItem {
    name: string
    size: number
    mtimeMs: number
    /**
     * A hash the backing can supply without reading the file (e.g. an S3 ETag that is known to be an md5).
     * Only used when the index is told to trust hints (useHints), e.g. to bootstrap a manifest.
     */
    hintMd5?: string
}

export interface IndexBacking {
    /** Human-readable location, for messages. */
    describe(): string

    /** Throws if the location cannot be used at all (missing folder, etc). */
    assertReachable(): Promise<void>

    /** Returns null if no manifest exists. Throws if one exists but is unreadable or malformed. */
    readManifest(): Promise<ManifestEntry[] | null>

    /** Must not leave a half-written manifest behind if interrupted. */
    writeManifest(entries: ManifestEntry[]): Promise<void>

    /** Publishes the index (file names only). Must not leave a half-written file behind if interrupted. */
    writeIndex(names: string[]): Promise<void>

    /** Lists files (not the manifest, the index, temp files, or folders). */
    list(): Promise<ListedItem[]>

    /** Reads the file and returns its md5. */
    hash(item: ListedItem): Promise<string>
}

export interface IndexOptions {
    /** Fail unless a manifest already exists. Guards against e.g. an unmounted share looking like an empty folder. */
    requireManifest?: boolean
    /** Ignore everything cached and hash every file. */
    rebuild?: boolean
    /** Accept `hintMd5` from the backing for files that have no valid cached entry, instead of reading them. */
    useHints?: boolean
    /** Also publish `.archivist-index.json`, a names-only listing for other consumers. Destinations default to on. */
    publishIndex?: boolean
    /** Warn, rather than fail, if the manifest cannot be written. For read-only locations (sources). */
    bestEffortWrite?: boolean
}

export class HashIndex {
    private entriesByName: Map<string, ManifestEntry> | null = null
    private hashes: Set<string> | null = null
    private dirty = false
    private indexDirty = true

    constructor(private backing: IndexBacking, private options: IndexOptions = {}) {
    }

    public get isLoaded(): boolean {
        return this.entriesByName !== null
    }

    public async ensureLoaded(): Promise<void> {
        if (!this.isLoaded) {
            await this.sync()
        }
    }

    public entries(): ManifestEntry[] {
        return [...this.loaded().values()]
    }

    public hasHash(md5: string): boolean {
        this.loaded()
        return this.hashes!.has(md5)
    }

    public hasName(name: string): boolean {
        return this.loaded().has(name)
    }

    /**
     * Records a file that was just saved to the location, so it does not need to be re-read on the next run.
     * `alsoKnownAs` is an extra hash (e.g. the source's claimed md5) to treat as present for the rest of this run.
     */
    public record(entry: ManifestEntry, alsoKnownAs?: string): void {
        const entries = this.loaded()
        if (entries.has(entry.name)) {
            throw Error('Generated filename collides with an existing file. Refusing to overwrite. :: ' + entry.name)
        }
        entries.set(entry.name, entry)
        this.hashes!.add(entry.md5)
        if (alsoKnownAs) {
            this.hashes!.add(alsoKnownAs)
        }
        this.dirty = true
        this.indexDirty = true
    }

    /** Reconciles the manifest with what is actually in the location, and persists it if anything changed. */
    public async sync(): Promise<void> {
        const where = this.backing.describe()
        await this.backing.assertReachable()

        const stored = await this.backing.readManifest()
        if (stored === null && this.options.requireManifest) {
            throw Error(
                `No ${MANIFEST_FILENAME} found, and requireManifest is set. ` +
                `If this location is a network share, check that it is mounted. ` +
                `To initialize a new location, run once without requireManifest. :: ${where}`)
        }
        const known = new Map((stored ?? []).map(x => [x.name, x]))
        const rebuild = !!this.options.rebuild

        const fresh = new Map<string, ManifestEntry>()
        const toHash: ListedItem[] = []
        let changed = stored === null || rebuild
        let hinted = 0
        for (const item of await this.backing.list()) {
            const previous = rebuild ? undefined : known.get(item.name)
            if (previous && previous.size === item.size && previous.mtimeMs === item.mtimeMs) {
                fresh.set(item.name, previous)
            } else if (this.options.useHints && !rebuild && item.hintMd5) {
                fresh.set(item.name, {name: item.name, md5: item.hintMd5, size: item.size, mtimeMs: item.mtimeMs})
                hinted++
                changed = true
            } else {
                toHash.push(item)
            }
        }
        if (hinted > 0) {
            console.log(`Used provided hashes for ${hinted} file(s) without reading them. :: ${where}`)
        }
        if (toHash.length > 0) {
            const megabytes = Math.round(toHash.reduce((sum, x) => sum + x.size, 0) / 1024 / 1024)
            console.log(`Hashing ${toHash.length} file(s), ${megabytes} MB in total. :: ${where}`)
        }
        for (const item of toHash) {
            console.log('Hashing :: ' + item.name)
            const md5 = await this.backing.hash(item)
            fresh.set(item.name, {name: item.name, md5, size: item.size, mtimeMs: item.mtimeMs})
            changed = true
        }
        if (fresh.size !== known.size) {
            changed = true // files were removed from the location
        }

        this.entriesByName = fresh
        this.hashes = new Set([...fresh.values()].map(x => x.md5))
        this.dirty = this.dirty || changed
        if (changed) {
            this.indexDirty = true // files were added or removed by someone else
        }
        await this.flushManifest()
    }

    /**
     * Persists the manifest if it has changes, then publishes the index (if enabled and out of date).
     * Safe to call repeatedly. Call once at the end of a run, so the index reflects everything saved.
     */
    public async flush(): Promise<void> {
        await this.flushManifest()
        if (!this.entriesByName || !this.options.publishIndex || !this.indexDirty) {
            return
        }
        const names = [...this.entriesByName.keys()].sort()
        await this.writeOrWarn('index', () => this.backing.writeIndex(names))
        this.indexDirty = false
    }

    private async flushManifest(): Promise<void> {
        if (!this.dirty || !this.entriesByName) {
            return
        }
        const entries = [...this.entriesByName.values()]
        await this.writeOrWarn('manifest', () => this.backing.writeManifest(entries))
        this.dirty = false
    }

    private async writeOrWarn(what: string, write: () => Promise<void>): Promise<void> {
        try {
            await write()
        } catch (e) {
            if (!this.options.bestEffortWrite) {
                throw e
            }
            console.warn(`Could not save ${what} (continuing without it). :: ${this.backing.describe()} :: ${e}`)
        }
    }

    private loaded(): Map<string, ManifestEntry> {
        if (this.entriesByName === null) {
            throw Error('Hash index used before it was loaded. This is a bug.')
        }
        return this.entriesByName
    }
}

export function parseManifest(text: string, where: string): ManifestEntry[] {
    let parsed: any
    try {
        parsed = JSON.parse(text)
    } catch (e) {
        throw Error(`Manifest is not valid JSON. Delete it or run with the rebuild option to regenerate. :: ${where}`)
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) {
        throw Error(`Manifest has an unrecognized format. Delete it or run with the rebuild option to regenerate. :: ${where}`)
    }
    const valid = parsed.files.every((x: any) =>
        typeof x?.name === 'string' && typeof x?.md5 === 'string' && typeof x?.size === 'number' && typeof x?.mtimeMs === 'number')
    if (!valid) {
        throw Error(`Manifest contains malformed entries. Delete it or run with the rebuild option to regenerate. :: ${where}`)
    }
    return parsed.files
}

export function serializeManifest(entries: ManifestEntry[]): string {
    return JSON.stringify({version: 1, files: entries})
}

export function serializeIndex(names: string[]): string {
    return JSON.stringify({version: 1, files: names})
}

export function isFlagSet(value: unknown): boolean {
    return value === true || value === 'true'
}

/** Reads the manifest-related runtime args that every source/destination accepts. */
export function indexOptionsFromArgs(args: any, bestEffortWrite = false, publishIndexByDefault = false): IndexOptions {
    return {
        requireManifest: isFlagSet(args?.requireManifest),
        rebuild: isFlagSet(args?.rebuild),
        useHints: isFlagSet(args?.seedFromEtag),
        publishIndex: args?.publishIndex === undefined ? publishIndexByDefault : isFlagSet(args.publishIndex),
        bestEffortWrite,
    }
}
