/**
 * One-off tool: after tools/remove_similar_media.py has removed duplicates from the NAS, remove the same files from S3.
 *
 * It does NOT mirror the NAS (which would delete anything in S3 that the NAS happens not to have). It only considers
 * files named in the find_similar_media.py JSON report (video groups, audio groups, unreadable files), and of those it
 * removes the ones that are now gone from the NAS. A report path is relative to the scanned folder, and is looked up
 * at the same relative path under the NAS folder and under the S3 prefix.
 *
 * Each first-level subfolder of the NAS folder is its own location (its own manifest and index), matching the same
 * subfolder name under the S3 prefix. Files directly in the top folder count as one more location.
 *
 * An object is deleted only if ALL of these hold:
 *  - the file is absent from the NAS folder (a file that is present, or present with a different size, is left alone);
 *  - the NAS subfolder it belongs to has a `.archivist-manifest.json` (an unmounted share would otherwise make
 *    everything look removed). A subfolder without one is skipped entirely and reported;
 *  - for duplicates: another member of one of its report groups still exists on the NAS with its recorded size, so
 *    this never removes the last remaining copy of anything;
 *  - the S3 object exists and has the size recorded in the report (so it is the same file that was scanned).
 * Unreadable files are removed when absent from the NAS and present in S3 with the recorded size.
 *
 * After deleting, each affected S3 location's manifest has those entries removed, and its published index (if it has
 * one) is rewritten.
 *
 * Usage (dry run unless --apply):
 *   node build/tools/pruneS3FromReport.js --region us-east-1 --bucket kaleidoscope-media --nas //guff-nas/video/kaleidoscope-media --report duplicates.json [--path some/prefix] [--apply]
 * (--path is only needed if the NAS folder corresponds to a prefix inside the bucket rather than the bucket root.)
 */
import fs from 'fs'
import path from 'path'
import minimist from 'minimist'
import {pathToFileURL} from 'url'
import {S3} from '@aws-sdk/client-s3'
import S3Backing from '../hashindex/S3Backing.js'
import {INDEX_FILENAME, MANIFEST_FILENAME} from '../hashindex/HashIndex.js'

export interface ReportMember {
    path: string
    size: number
}

export interface Report {
    video: ReportMember[][]
    audio: ReportMember[][]
    unreadable: ReportMember[]
}

export function parseReport(text: string): Report {
    let parsed: any
    try {
        parsed = JSON.parse(text)
    } catch (e) {
        throw Error('The report is not valid JSON. It must be the .json report from find_similar_media.py (not the cache or a text report).')
    }
    const isMember = (x: any) => typeof x?.path === 'string' && typeof x?.size === 'number'
    const valid = Array.isArray(parsed?.video) && Array.isArray(parsed?.audio) && Array.isArray(parsed?.unreadable)
        && [...parsed.video, ...parsed.audio].every((g: any) => Array.isArray(g) && g.every(isMember))
        && parsed.unreadable.every(isMember)
    if (!valid) {
        throw Error('The file is not a find_similar_media.py JSON report (needs video, audio and unreadable lists).')
    }
    return parsed
}

export interface PruneAction {
    name: string
    size: number
    reason: string
}

export interface PrunePlan {
    toDelete: PruneAction[]
    /** Counts of files left alone, by reason. */
    kept: Map<string, number>
}

/** 'unverified' means the file's NAS subfolder has no manifest, so its state on the NAS can't be trusted. */
type NasState = 'present' | 'absent' | 'changed' | 'unverified'

/** Pure planning step: `nas` gives the state of each report member on the NAS, `s3Sizes` is name -> size in S3. */
export function planPrune(report: Report, nas: Map<string, NasState>, s3Sizes: Map<string, number>): PrunePlan {
    const plan: PrunePlan = {toDelete: [], kept: new Map()}
    const keep = (reason: string) => plan.kept.set(reason, (plan.kept.get(reason) ?? 0) + 1)
    const state = (p: string) => nas.get(p) ?? 'absent'
    const done = new Set<string>()

    const consider = (m: ReportMember, reason: string) => {
        if (done.has(m.path)) {
            return
        }
        done.add(m.path)
        const s3Size = s3Sizes.get(m.path)
        if (s3Size === undefined) {
            return keep('not in S3 (nothing to remove)')
        }
        if (s3Size !== m.size) {
            return keep('S3 object has a different size than the scanned file')
        }
        plan.toDelete.push({name: m.path, size: m.size, reason})
    }

    const groups = [...report.video, ...report.audio]
    const groupsOf = new Map<string, ReportMember[][]>()
    for (const g of groups) {
        for (const m of g) {
            groupsOf.set(m.path, [...(groupsOf.get(m.path) ?? []), g])
        }
    }
    for (const [p, gs] of groupsOf) {
        const member = gs[0].find(x => x.path === p)!
        if (state(p) === 'unverified') {
            keep('its NAS subfolder has no manifest (not checked)')
        } else if (state(p) === 'present') {
            keep('still on the NAS')
        } else if (state(p) === 'changed') {
            keep('on the NAS with a different size than scanned')
        } else if (!gs.some(g => g.some(x => x.path !== p && state(x.path) === 'present'))) {
            keep('no other member of its group survives on the NAS')
        } else {
            consider(member, 'removed from NAS as a duplicate')
        }
    }
    for (const m of report.unreadable) {
        if (groupsOf.has(m.path)) {
            continue
        }
        if (state(m.path) === 'unverified') {
            keep('its NAS subfolder has no manifest (not checked)')
        } else if (state(m.path) === 'present') {
            keep('still on the NAS')
        } else if (state(m.path) === 'changed') {
            keep('on the NAS with a different size than scanned')
        } else {
            consider(m, 'removed from NAS as unreadable')
        }
    }
    return plan
}

export interface PruneOptions {
    apply: boolean
}

/** Where the media lives in S3: `basePrefix` (empty, or ending in "/") is what the NAS folder corresponds to. */
export interface S3Target {
    getClient: () => S3
    bucket: string
    basePrefix: string
}

export interface PruneResult {
    plan: PrunePlan
    deleted: string[]
    failed: string[]
    /** Subfolders that were skipped because the NAS had no manifest there. */
    skippedLocations: string[]
}

/** The location (first-level subfolder, or '' for files directly in the top folder) a report path belongs to. */
const locationOf = (p: string) => p.includes('/') ? p.slice(0, p.indexOf('/')) : ''
const backingFor = (target: S3Target, location: string) =>
    new S3Backing(target.getClient, target.bucket, target.basePrefix + (location ? location + '/' : ''))

export async function pruneS3(report: Report, nasRoot: string, target: S3Target, options: PruneOptions): Promise<PruneResult> {
    const stat = await fs.promises.stat(nasRoot).catch(() => null)
    if (!stat?.isDirectory()) {
        throw Error('The NAS folder does not exist or is not a directory. :: ' + nasRoot)
    }

    const all = [...report.video.flat(), ...report.audio.flat(), ...report.unreadable]
    const resolvedRoot = path.resolve(nasRoot)
    const locations = [...new Set(all.map(m => locationOf(m.path)))].sort()
    const usable = new Set(locations.filter(loc => fs.existsSync(path.join(resolvedRoot, loc, MANIFEST_FILENAME))))
    const skippedLocations = locations.filter(loc => !usable.has(loc))
    if (usable.size === 0 && locations.length > 0) {
        throw Error(`No ${MANIFEST_FILENAME} found in any NAS subfolder named by the report. If it is a network share, check that it is mounted. :: ${nasRoot}`)
    }

    const nas = new Map<string, NasState>()
    for (const m of all) {
        const full = path.resolve(resolvedRoot, m.path)
        if (!full.startsWith(resolvedRoot + path.sep)) {
            throw Error('Report path escapes the NAS folder. :: ' + m.path)
        }
        if (!usable.has(locationOf(m.path))) {
            nas.set(m.path, 'unverified')
            continue
        }
        const s = await fs.promises.stat(full).catch(() => null)
        nas.set(m.path, !s || !s.isFile() ? 'absent' : s.size === m.size ? 'present' : 'changed')
    }

    const s3Sizes = new Map<string, number>()
    for (const loc of usable) {
        for (const item of await backingFor(target, loc).list()) {
            s3Sizes.set(loc ? `${loc}/${item.name}` : item.name, item.size)
        }
    }
    const plan = planPrune(report, nas, s3Sizes)
    const result: PruneResult = {plan, deleted: [], failed: [], skippedLocations}
    if (!options.apply || plan.toDelete.length === 0) {
        return result
    }

    const client = target.getClient()
    for (let i = 0; i < plan.toDelete.length; i += 1000) {
        const batch = plan.toDelete.slice(i, i + 1000)
        const response: any = await client.deleteObjects({
            Bucket: target.bucket,
            Delete: {Objects: batch.map(x => ({Key: target.basePrefix + x.name})), Quiet: true}
        })
        const failedKeys = new Set<string>((response?.Errors ?? []).map((e: any) => e.Key))
        for (const x of batch) {
            (failedKeys.has(target.basePrefix + x.name) ? result.failed : result.deleted).push(x.name)
        }
    }

    for (const loc of new Set(result.deleted.map(locationOf))) {
        const names = new Set(result.deleted.filter(x => locationOf(x) === loc).map(x => loc ? x.slice(loc.length + 1) : x))
        await updateManifestAndIndex(backingFor(target, loc), target, names)
    }
    return result
}

async function updateManifestAndIndex(s3: S3Backing, target: S3Target, deleted: Set<string>): Promise<void> {
    const manifest = await s3.readManifest()
    if (manifest) {
        await s3.writeManifest(manifest.filter(x => !deleted.has(x.name)))
    } else {
        console.warn('No S3 manifest found, so none was updated. :: ' + s3.describe())
    }
    // Only refresh the published index if this location has one (publishing it is optional).
    const hasIndex = await target.getClient().headObject({Bucket: s3.bucket, Key: s3.prefix + INDEX_FILENAME}).then(() => true, () => false)
    if (hasIndex) {
        await s3.writeIndex((await s3.list()).map(x => x.name).sort())
    }
}

const human = (n: number) => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB'

function printResult(where: string, result: PruneResult, apply: boolean): void {
    const {plan} = result
    console.log(`\n${where}`)
    if (result.skippedLocations.length > 0) {
        console.log(`Skipped NAS subfolder(s) with no manifest: ${result.skippedLocations.map(x => x || '(top folder)').join(', ')}`)
    }
    for (const x of plan.toDelete) {
        console.log(`${apply ? 'Deleting' : 'Would delete'}: ${x.name}  [${human(x.size)}]  -- ${x.reason}`)
    }
    const total = plan.toDelete.reduce((sum, x) => sum + x.size, 0)
    console.log('\n' + '='.repeat(60))
    console.log(`SUMMARY (${apply ? 'applied' : 'dry run - nothing changed; pass --apply to do it'})`)
    console.log(`  ${apply ? 'Deleted' : 'Delete'} from S3: ${apply ? result.deleted.length : plan.toDelete.length} object(s), ${human(total)}`)
    if (result.failed.length > 0) {
        console.log(`  FAILED to delete: ${result.failed.length}`)
        result.failed.slice(0, 10).forEach(x => console.log(`      ${x}`))
    }
    console.log(`  Left alone: ${[...plan.kept.values()].reduce((a, b) => a + b, 0)} object(s)`)
    for (const [reason, n] of [...plan.kept].sort()) {
        console.log(`      ${String(n).padStart(6)}  ${reason}`)
    }
}

async function main() {
    const args = minimist(process.argv.slice(2))
    for (const required of ['region', 'bucket', 'nas', 'report']) {
        if (!args[required]) {
            throw Error(`Missing required argument --${required}`)
        }
    }
    const given = args.path ? String(args.path) : ''
    const basePrefix = given === '' || given.endsWith('/') ? given : given + '/'
    const client = new S3({region: args.region})
    const target: S3Target = {getClient: () => client, bucket: args.bucket, basePrefix}
    const report = parseReport(await fs.promises.readFile(args.report, 'utf8'))
    const apply = !!args.apply

    const result = await pruneS3(report, args.nas, target, {apply})
    printResult(`s3://${args.bucket}/${basePrefix}`, result, apply)
}

// Only runs when invoked directly, so the functions above can be imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => {
        console.error(String(e))
        process.exit(1)
    })
}
