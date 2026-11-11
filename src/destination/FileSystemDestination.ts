import path from 'path'
import fs from 'fs'
import FileMeta from "../model/FileMeta.js";
import FileUtils from "../FileUtils.js";
import {DestinationInterface} from "./DestinationInterface.js";
import {MANIFEST_FILENAME, ManifestEntry, readManifest, TEMP_SUFFIX, writeManifest} from "./FileManifest.js";

export default class FileSystemDestination implements DestinationInterface {
    basepath: string
    requireManifest: boolean
    rebuild: boolean

    private entries: Map<string, ManifestEntry> | null = null // keyed by filename
    private hashes: Set<string> | null = null
    private dirty = false

    constructor(destinationargs: any) {
        if (!destinationargs) {
            this.printHelp()
            throw Error('Missing or undefined destinationargs found during initialization of FileSystemDestination')
        }
        if (!destinationargs.path) {
            this.printHelp()
            throw Error('Missing required argument for destination initialization :: ' + 'destination.path')
        }
        this.basepath = path.resolve(process.cwd(), destinationargs.path)
        this.requireManifest = isFlagSet(destinationargs.requireManifest)
        this.rebuild = isFlagSet(destinationargs.rebuild)

        console.log('File System destination has been initialized.')
        console.log(`Folder Path: ${this.basepath}\n`)
    }

    public printHelp(): void {
        console.log(
            `
Required parameters for FileSystemDestination:
    destination.path - The path to the folder that is being targeted.
                       The folder must already exist. This path can be relative.
Optional parameters:
    destination.requireManifest - Abort unless ${MANIFEST_FILENAME} already exists in the folder.
                                  Guards against writing into an empty, unmounted network share.
    destination.rebuild         - Ignore cached hashes and re-hash every file in the folder.
            `
        )
    }

    public async saveMedia(filemeta: FileMeta, rawfilepromise: Promise<Buffer>): Promise<void> {
        if (await this.doesFileAlreadyExist(filemeta)) {
            return
        }

        const raw = await rawfilepromise
        const filename = FileUtils.getUniqueName(filemeta.name)
        if (this.entries!.has(filename)) {
            throw Error('Generated filename collides with an existing file. Refusing to overwrite. :: ' + filename)
        }

        const newpath = path.resolve(this.basepath, filename)
        const temppath = newpath + TEMP_SUFFIX
        await fs.promises.writeFile(temppath, raw)
        await fs.promises.rename(temppath, newpath)

        const stat = await fs.promises.stat(newpath)
        const md5 = FileUtils.getMd5(raw)
        this.entries!.set(filename, {name: filename, md5, size: stat.size, mtimeMs: stat.mtimeMs})
        this.hashes!.add(md5)
        this.hashes!.add(filemeta.md5) // so a source reporting a differing hash still isn't saved twice in one run
        this.dirty = true
    }

    public async getExistingMeta(): Promise<FileMeta[]> {
        await this.sync()
        return [...this.entries!.values()].map(x => {
            const uri = path.resolve(this.basepath, x.name)
            return new FileMeta(x.name, uri, path.extname(x.name), x.md5)
        })
    }

    /** Persists any changes to the manifest. Should be called once at the end of a run. */
    public async close(): Promise<void> {
        if (this.dirty && this.entries) {
            await writeManifest(this.basepath, [...this.entries.values()])
            this.dirty = false
        }
    }

    private async doesFileAlreadyExist(filemeta: FileMeta): Promise<boolean> {
        if (this.entries == null) {
            await this.sync()
        }
        return this.hashes!.has(filemeta.md5)
    }

    /**
     * Reconciles the manifest with what is actually on disk.
     * Only files that are new or whose size/mtime changed get hashed. The manifest is persisted if anything changed.
     */
    private async sync(): Promise<void> {
        const stat = await fs.promises.stat(this.basepath).catch(() => null)
        if (!stat || !stat.isDirectory()) {
            throw Error('Destination folder does not exist or is not a directory. :: ' + this.basepath)
        }

        const stored = await readManifest(this.basepath)
        if (stored === null && this.requireManifest) {
            throw Error(
                `No ${MANIFEST_FILENAME} found in destination, and destination.requireManifest is set. ` +
                `If the folder is a network share, check that it is mounted. ` +
                `To initialize a new folder, run once without requireManifest. :: ${this.basepath}`)
        }
        const known = new Map((stored ?? []).map(x => [x.name, x]))

        const fresh = new Map<string, ManifestEntry>()
        let changed = stored === null || this.rebuild
        const dirents = await fs.promises.readdir(this.basepath, {withFileTypes: true})
        for (const dirent of dirents) {
            if (!dirent.isFile() || dirent.name === MANIFEST_FILENAME || dirent.name.endsWith(TEMP_SUFFIX)) {
                continue
            }
            const filepath = path.resolve(this.basepath, dirent.name)
            const filestat = await fs.promises.stat(filepath)
            const previous = this.rebuild ? undefined : known.get(dirent.name)
            if (previous && previous.size === filestat.size && previous.mtimeMs === filestat.mtimeMs) {
                fresh.set(dirent.name, previous)
                continue
            }
            console.log('Hashing :: ' + dirent.name)
            const md5 = await FileUtils.getMd5OfFile(filepath)
            fresh.set(dirent.name, {name: dirent.name, md5, size: filestat.size, mtimeMs: filestat.mtimeMs})
            changed = true
        }
        if (fresh.size !== known.size) {
            changed = true // files were removed from the folder
        }

        this.entries = fresh
        this.hashes = new Set([...fresh.values()].map(x => x.md5))
        this.dirty = this.dirty || changed
        if (changed) {
            await this.close()
        }
    }
}

function isFlagSet(value: unknown): boolean {
    return value === true || value === 'true'
}
