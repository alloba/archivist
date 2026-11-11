import fs from 'fs'
import path from 'path'
import FileUtils from '../FileUtils.js'
import {
    IndexBacking,
    INDEX_FILENAME,
    ListedItem,
    MANIFEST_FILENAME,
    ManifestEntry,
    parseManifest,
    serializeIndex,
    serializeManifest,
    TEMP_SUFFIX
} from './HashIndex.js'

/** A folder on disk (including a mounted network share). Subfolders are not indexed. */
export default class FileSystemBacking implements IndexBacking {
    constructor(public dir: string) {
    }

    describe(): string {
        return this.dir
    }

    async assertReachable(): Promise<void> {
        const stat = await fs.promises.stat(this.dir).catch(() => null)
        if (!stat || !stat.isDirectory()) {
            throw Error('Folder does not exist or is not a directory. :: ' + this.dir)
        }
    }

    async readManifest(): Promise<ManifestEntry[] | null> {
        const manifestPath = path.join(this.dir, MANIFEST_FILENAME)
        let text: string
        try {
            text = await fs.promises.readFile(manifestPath, 'utf8')
        } catch (e: any) {
            if (e.code === 'ENOENT') {
                return null
            }
            throw e
        }
        return parseManifest(text, manifestPath)
    }

    /** Written to a temp file and renamed, so an interrupted write never leaves a truncated manifest behind. */
    async writeManifest(entries: ManifestEntry[]): Promise<void> {
        const manifestPath = path.join(this.dir, MANIFEST_FILENAME)
        const tempPath = manifestPath + TEMP_SUFFIX
        await fs.promises.writeFile(tempPath, serializeManifest(entries))
        await fs.promises.rename(tempPath, manifestPath)
    }

    async writeIndex(names: string[]): Promise<void> {
        const indexPath = path.join(this.dir, INDEX_FILENAME)
        const tempPath = indexPath + TEMP_SUFFIX
        await fs.promises.writeFile(tempPath, serializeIndex(names))
        await fs.promises.rename(tempPath, indexPath)
    }

    async list(): Promise<ListedItem[]> {
        const items: ListedItem[] = []
        for (const dirent of await fs.promises.readdir(this.dir, {withFileTypes: true})) {
            if (!dirent.isFile() || dirent.name === MANIFEST_FILENAME || dirent.name === INDEX_FILENAME || dirent.name.endsWith(TEMP_SUFFIX)) {
                continue
            }
            const stat = await fs.promises.stat(path.join(this.dir, dirent.name))
            items.push({name: dirent.name, size: stat.size, mtimeMs: stat.mtimeMs})
        }
        return items
    }

    hash(item: ListedItem): Promise<string> {
        return FileUtils.getMd5OfFile(path.join(this.dir, item.name))
    }
}
