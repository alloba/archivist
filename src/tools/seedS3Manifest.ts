/**
 * One-off tool: build the manifest for an S3 prefix from the manifest of a local/NAS folder that mirrors it,
 * so the first real run does not have to download every object to hash it.
 *
 * It does not blindly copy. Each S3 object (from a listing) is matched to the folder's entry by name, and:
 *  - sizes must be equal;
 *  - if the object's ETag is a plain md5, it must equal the folder's hash (so this doubles as an integrity check
 *    of the folder against the bucket, and a disagreement is reported and excluded);
 *  - if the ETag is not a plain md5 (multipart/KMS), the folder file's mtime must match the object's LastModified
 *    instead, since there is nothing else to check against.
 * Entries are saved with the S3 LastModified as their mtime, which is what later runs compare against.
 * Anything that doesn't qualify is simply left out, and will be hashed by a normal run.
 *
 * Usage (dry run unless --write):
 *   node build/tools/seedS3Manifest.js --region us-east-1 --bucket kaleidoscope-media --path wsg --from //guff-nas/video/kaleidoscope-media/wsg [--write] [--overwrite] [--allowConflicts]
 */
import minimist from 'minimist'
import {pathToFileURL} from 'url'
import {S3} from '@aws-sdk/client-s3'
import S3Backing from '../hashindex/S3Backing.js'
import FileSystemBacking from '../hashindex/FileSystemBacking.js'
import {ListedItem, MANIFEST_FILENAME, ManifestEntry} from '../hashindex/HashIndex.js'

/** S3 LastModified has one-second resolution, so local mtimes are compared with that tolerance. */
const MTIME_TOLERANCE_MS = 1000

export interface SeedReport {
    entries: ManifestEntry[]
    verifiedByEtag: number
    trustedByMtime: number
    notInFolder: string[]
    sizeMismatch: string[]
    hashConflicts: { name: string, folderMd5: string, etag: string }[]
    unverifiable: string[]
    folderOnly: string[]
}

export function buildSeed(listed: ListedItem[], folderEntries: ManifestEntry[]): SeedReport {
    const folderByName = new Map(folderEntries.map(x => [x.name, x]))
    const report: SeedReport = {
        entries: [], verifiedByEtag: 0, trustedByMtime: 0,
        notInFolder: [], sizeMismatch: [], hashConflicts: [], unverifiable: [], folderOnly: []
    }

    for (const item of listed) {
        const local = folderByName.get(item.name)
        if (!local) {
            report.notInFolder.push(item.name)
        } else if (local.size !== item.size) {
            report.sizeMismatch.push(item.name)
        } else if (item.hintMd5 && item.hintMd5 !== local.md5) {
            report.hashConflicts.push({name: item.name, folderMd5: local.md5, etag: item.hintMd5})
        } else if (!item.hintMd5 && Math.abs(local.mtimeMs - item.mtimeMs) >= MTIME_TOLERANCE_MS) {
            report.unverifiable.push(item.name)
        } else {
            item.hintMd5 ? report.verifiedByEtag++ : report.trustedByMtime++
            report.entries.push({name: item.name, md5: local.md5, size: item.size, mtimeMs: item.mtimeMs})
        }
    }

    const listedNames = new Set(listed.map(x => x.name))
    report.folderOnly = folderEntries.map(x => x.name).filter(x => !listedNames.has(x))
    return report
}

export interface SeedOptions {
    write: boolean
    /** Replace an S3 manifest that already exists. */
    overwrite: boolean
    /** Write even though some objects disagree with the folder (those objects are excluded). */
    allowConflicts: boolean
}

export async function seedS3Manifest(s3: S3Backing, folder: FileSystemBacking, options: SeedOptions): Promise<SeedReport> {
    await folder.assertReachable()
    const folderEntries = await folder.readManifest()
    if (folderEntries === null) {
        throw Error(`The folder has no ${MANIFEST_FILENAME}. Run archivist against it first so it is hashed. :: ${folder.describe()}`)
    }
    if (!options.overwrite && await s3.readManifest() !== null) {
        throw Error(`An S3 manifest already exists. Use --overwrite to replace it. :: ${s3.describe()}`)
    }

    const report = buildSeed(await s3.list(), folderEntries)

    if (options.write) {
        if (report.hashConflicts.length > 0 && !options.allowConflicts) {
            throw Error(`${report.hashConflicts.length} object(s) disagree with the folder's hashes. Nothing was written. ` +
                `Investigate, or use --allowConflicts to write the manifest without them. :: ${s3.describe()}`)
        }
        await s3.writeManifest(report.entries)
    }
    return report
}

function printReport(where: string, report: SeedReport, wrote: boolean): void {
    const list = (label: string, items: string[]) => {
        if (items.length > 0) {
            console.log(`  ${label}: ${items.length}`)
            items.slice(0, 5).forEach(x => console.log(`      ${x}`))
            if (items.length > 5) console.log(`      ... and ${items.length - 5} more`)
        }
    }
    console.log(`\n${where}`)
    console.log(`  seeded entries: ${report.entries.length} (${report.verifiedByEtag} confirmed by ETag, ${report.trustedByMtime} by size and mtime)`)
    if (report.hashConflicts.length > 0) {
        console.log(`  HASH CONFLICTS (object ETag differs from folder hash): ${report.hashConflicts.length}`)
        report.hashConflicts.slice(0, 5).forEach(x => console.log(`      ${x.name} folder=${x.folderMd5} etag=${x.etag}`))
    }
    list('size mismatch (left out)', report.sizeMismatch)
    list('not in folder (left out)', report.notInFolder)
    list('no verification possible (left out)', report.unverifiable)
    list('in folder only, not in S3 (ignored)', report.folderOnly)
    console.log(wrote ? '  manifest WRITTEN' : '  dry run, nothing written (use --write)')
}

async function main() {
    const args = minimist(process.argv.slice(2))
    for (const required of ['region', 'bucket', 'path', 'from']) {
        if (!args[required]) {
            throw Error(`Missing required argument --${required}`)
        }
    }
    const prefix = args.path.endsWith('/') ? args.path : args.path + '/'
    const s3 = new S3Backing(() => new S3({region: args.region}), args.bucket, prefix)
    const options: SeedOptions = {write: !!args.write, overwrite: !!args.overwrite, allowConflicts: !!args.allowConflicts}

    const report = await seedS3Manifest(s3, new FileSystemBacking(args.from), options)
    printReport(s3.describe(), report, options.write)
}

// Only runs when invoked directly, so the functions above can be imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => {
        console.error(String(e))
        process.exit(1)
    })
}
