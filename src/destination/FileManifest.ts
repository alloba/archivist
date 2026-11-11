import fs from 'fs'
import path from 'path'

/**
 * A manifest is a cache of md5 hashes for the files in one media directory, stored in that same directory.
 * It exists so that large directories (e.g. on a NAS) do not need to be re-read and re-hashed on every run.
 * Entries are only trusted while name, size and mtime still match what is on disk.
 * The manifest is purely a cache: it can be deleted at any time and will be rebuilt by the next scan.
 */
export const MANIFEST_FILENAME = '.archivist-manifest.json'

/** Suffix for files that are still being written. Scans ignore these. */
export const TEMP_SUFFIX = '.archivist-tmp'

export interface ManifestEntry {
    name: string
    md5: string
    size: number
    mtimeMs: number
}

interface ManifestFile {
    version: 1
    files: ManifestEntry[]
}

/** Returns null if no manifest exists. Throws if one exists but is unreadable or malformed. */
export async function readManifest(dir: string): Promise<ManifestEntry[] | null> {
    const manifestPath = path.join(dir, MANIFEST_FILENAME)
    let text: string
    try {
        text = await fs.promises.readFile(manifestPath, 'utf8')
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            return null
        }
        throw e
    }

    let parsed: any
    try {
        parsed = JSON.parse(text)
    } catch (e) {
        throw Error(`Manifest is not valid JSON. Delete it or run with destination.rebuild to regenerate. :: ${manifestPath}`)
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) {
        throw Error(`Manifest has an unrecognized format. Delete it or run with destination.rebuild to regenerate. :: ${manifestPath}`)
    }
    const valid = parsed.files.every((x: any) =>
        typeof x?.name === 'string' && typeof x?.md5 === 'string' && typeof x?.size === 'number' && typeof x?.mtimeMs === 'number')
    if (!valid) {
        throw Error(`Manifest contains malformed entries. Delete it or run with destination.rebuild to regenerate. :: ${manifestPath}`)
    }
    return parsed.files
}

/** Written to a temp file and renamed, so an interrupted write never leaves a truncated manifest behind. */
export async function writeManifest(dir: string, entries: ManifestEntry[]): Promise<void> {
    const manifestPath = path.join(dir, MANIFEST_FILENAME)
    const tempPath = manifestPath + TEMP_SUFFIX
    const body: ManifestFile = {version: 1, files: entries}
    await fs.promises.writeFile(tempPath, JSON.stringify(body))
    await fs.promises.rename(tempPath, manifestPath)
}
