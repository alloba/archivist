# Archivist

Scan sources for media and save results. 

Targeted sources will be scanned for all available files, and results will be compared 
with the destination specified during initialization. Anything that does not already exist in 
the destination will be pulled from the source. 

Sources and destinations rely on generic interfaces, so the specific mechanism can vary 
for both the uniqueness check and the download. 
However, the primary use case for this project is to interface with 4Chan boards, to save to 
either a local directory or a S3 bucket. 
So generally expect examples to align with those items. 

## Usage 

This program is run via NPM, and needs Node 20 or newer (the AWS SDK requires it).
It relies heavily on runtime parameters for source/destination methods.  

### Examples 

Source and destination can be mixed freely. Below are some examples.

**LocalStorage source and S3 destination**  
`npm run start -- --source.type fs --source.path ./testSourceFiles --destination.type s3 --destination.bucket kaleidoscope-media --destination.path testOutputFiles --destination.region us-east-1 --serious`

**4Chan source to LocalStorage destination**   
`npm run start -- --source.type 4chan --source.path wsg --source.search ygyl --destination.type fs --destination.path .\testOutputFiles --serious`

**Multiple destinations (S3 and a local/NAS folder in one run)**  
Index the destination args: `--destination.0.*` is the first destination, `--destination.1.*` the second, and so on.  
`npm run start -- --source.type 4chan --source.path wsg --source.search ygyl --destination.0.type s3 --destination.0.region us-east-1 --destination.0.bucket kaleidoscope-media --destination.0.path wsg --destination.1.type fs --destination.1.path /mnt/nas/wsg --destination.1.requireManifest --serious`

Each destination decides for itself what it is missing, so destinations that drift apart will each catch up on the next run
(as long as the source still has the file). Each needed file is downloaded once and given to every destination that needs it.
Each file is also saved under the same unique filename in every destination, so mirrors match by name as well as by content.
If a destination cannot be read at the start of a run, nothing is saved anywhere and the run fails.
If a save fails partway through, the remaining files and destinations are still attempted, and the run fails at the end.

## Tests

`npm test` compiles and runs the unit tests (Node's built-in test runner; requires Node 21+ for the glob in the test script).

## Configuration

All parameters listed in this section must be provided as runtime parameters.

Exceptions include: 
- AWS Credentials. These are loaded using the SDK's resolution chain. Meaning credentials file, environment variables,
  an `aws login` or SSO session, etc. (Sessions from `aws login` need a recent SDK, which is why `@aws-sdk/client-s3`
  is kept up to date.)

### Generic Configuration
| Param      | Description                                                                                                                                                                     |
|------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `serious`  | This flag is required to exist before files actually download and save. Leaving this off will still query the source/destination for metadata, but no new items will be placed. |
| `ultradry` | This flag will prevent any outgoing requests, including querying for metadata. This is disabled by default, and is really only for troubleshooting.                             |

### Hash manifests

Everything that holds files (the FileSystem and S3 sources and destinations) de-dupes through the same mechanism:
a manifest, `.archivist-manifest.json`, stored in the folder (or under the S3 prefix) itself, which caches the md5 of
each file. S3 metadata (ETags) is not used as the source of truth.

On each run the location is listed (names, sizes and modification times only), and only files that are new or whose
size/mtime differ from the manifest are hashed, by reading them. The manifest is saved if anything changed.
It is purely a cache: it can be deleted at any time and will be rebuilt by the next scan (hashing everything once).

These optional flags work on every FileSystem and S3 source or destination (`source.*` or `destination.*`):

| Param             | Description                                                                                                                                                                                                                                        |
|-------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `requireManifest` | Abort unless a manifest already exists. Use this for network shares (an unmounted share looks like an empty folder) and for S3 (so a missing manifest fails the run instead of downloading every object to hash it).                               |
| `rebuild`         | Ignore the cached hashes and re-hash everything. Useful as an occasional audit.                                                                                                                                                                    |
| `seedFromEtag`    | S3 only. For objects with no cached hash, accept the ETag as the md5 instead of downloading the object. This is for bootstrapping a manifest once. It only applies to ETags that look like a plain md5 (not multipart or KMS uploads), which are downloaded and hashed as normal. |

### Published index

Every destination also publishes `.archivist-index.json` beside the manifest: `{"version":1,"files":["a_1.webm", ...]}`,
the sorted names of every file in the location (relative to it, without the manifest or the index itself). Unlike the
manifest, which is a private cache of hashes, this is meant for other consumers. For example, the kaleidoscope web page
reads it to get the media list in a few small requests instead of paging through a 27k-object S3 listing.

It is rewritten at the end of every run (so locations that predate it get one on their next run), and is never treated as
media by scans. On S3 it is uploaded with `Cache-Control: no-cache` and no ACL (the bucket policy decides who can read it).
Pass `--destination.publishIndex false` to turn it off. Sources never write one.

Sources save their manifest too, but a source may be read-only, so failing to save it is only a warning.
The 4Chan source gets hashes from the 4Chan api and has no manifest.

**Bootstrapping a manifest for an existing S3 prefix** (so the first run does not download every object).
Any run that scans the prefix saves the manifest, including a dry run (no `--serious`):
`npm run start -- --source.type s3 --source.region us-east-1 --source.bucket kaleidoscope-media --source.path wsg --source.seedFromEtag --destination.type fs --destination.path ./scratch`

**Bootstrapping from a folder that mirrors the prefix** (instead of `seedFromEtag`). If a local or NAS folder that
already has a manifest holds a copy of the prefix, its hashes can be reused. This does not blindly copy the manifest:
each object is matched by name and size, and its ETag (when it is a plain md5) must agree with the folder's hash, so it
doubles as an integrity check of the folder against the bucket. Disagreeing objects are reported and left out. Objects
without a plain md5 ETag need a matching modification time instead. It is a dry run unless `--write` is given, and
refuses to replace an existing S3 manifest without `--overwrite`:  
`npm run seed-s3-manifest -- --region us-east-1 --bucket kaleidoscope-media --path wsg --from //guff-nas/video/kaleidoscope-media/wsg --write`

If you sync a prefix down with `aws s3 sync`, add `--exclude ".archivist-manifest.json"` so the S3 manifest does not overwrite the local one.

### Sources

#### 4Chan  

The OG. Specifying 4Chan as a source will cause this program to reach out to the site when looking for media files. 
This source relies on basic interaction with the api that is provided by the site to pull individual threads and 
their contents. 

Interactions with the 4Chan api are limited by policy to 1 per second. 
So total operations for this source can take a few minutes depending on content. 
Only `.webm` files are collected. 

**Configuration** 

| Param                     | Description                                                                                                                                                                                      | Example Values          |
|---------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------|
| source.type               | Identifies what type of source to load.                                                                                                                                                          | `4chan`                 |
| source.path               | Which board to use as a source for the media scan.                                                                                                                                               | `wsg`, `gif`            |
| source.search             | The search string to use when looking for threads to pull media from. This would be a substring of the thread title, case-insensitive.                                                           | `ygyl`, `ylyl`, `comfy` |

#### FileSystem

Local file directory as a source. Subfolders are not scanned, and files without an extension are ignored.
Hashes are cached in a manifest in the folder (see "Hash manifests").

**Configuration**

| Param       | Description                                                                           | Example Values      |
|-------------|---------------------------------------------------------------------------------------|---------------------|
| source.path | Path to the source folder. The folder must already exist, and may be a relative path. | `../source_folder/` |

Optional: `source.requireManifest`, `source.rebuild` (see "Hash manifests").

#### S3 Source

An S3 bucket as a backing source. 
S3 locations assume a properly prepared environment in context of AWS credentials. 
This means that credentials must either be set in a config file, or environment variables must be set properly.
Hashes are cached in a manifest object under the path (see "Hash manifests").

**Configuration**

| Param         | Description                                                                       | Example Values       |
|---------------|-----------------------------------------------------------------------------------|----------------------|
| source.region | AWS Region that the target S3 bucket is located in.                               | `us-east-1`          |
| source.bucket | S3 bucket to target.                                                              | `kaleidoscope-media` |
| source.path   | Subdirectory to store files in (yeah yeah yeah 'is a key not a directory' shush). | `output_folder/`     |

Optional: `source.requireManifest`, `source.rebuild`, `source.seedFromEtag` (see "Hash manifests").


### Destinations

#### FileSystem

Local storage (including a mounted network share) as a destination.

Hashes are cached in a manifest in the folder (see "Hash manifests"). It is written atomically, and scans ignore it
along with subfolders. Files that were not saved by this tool are picked up and hashed on the next run.

**Configuration**

| Param                       | Description                                                                                                                                                                                                                                | Example Values           |
|-----------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------|
| destination.path            | Path to the destination folder. The folder must already exist, and may be a relative path.                                                                                                                                                 | `../destination_folder/` |
| destination.requireManifest | Optional flag. Abort unless a manifest already exists in the folder. Use this for network shares: if the share is unmounted, the folder is empty and the run fails instead of writing to the wrong disk. Create the manifest by running once without this flag. | `--destination.requireManifest` |
| destination.rebuild         | Optional flag. Ignore the cached hashes and re-hash every file. Useful as an occasional audit.                                                                                                                                             | `--destination.rebuild`  |

#### S3

An S3 bucket as a destination.
S3 locations assume a properly prepared environment in context of AWS credentials.
This means that credentials must either be set in a config file, or environment variables must be set properly.
Only `.webm` files can be saved (any other extension fails the save, since the content type is not known).

| Param              | Description                                                                       | Example Values       |
|--------------------|-----------------------------------------------------------------------------------|----------------------|
| destination.region | AWS Region that the target S3 bucket is located in.                               | `us-east-1`          |
| destination.bucket | S3 bucket to target.                                                              | `kaleidoscope-media` |
| destination.path   | Subdirectory to store files in (yeah yeah yeah 'is a key not a directory' shush). | `output_folder/`     |

Hashes are cached in a manifest object under the path, `<path>/.archivist-manifest.json`, which is saved without the
public ACL that the media gets. Optional: `destination.requireManifest`, `destination.rebuild`,
`destination.seedFromEtag`, `destination.publishIndex` (see "Hash manifests" and "Published index").

## Saving to a NAS from CI

The scheduled workflow (`.github/workflows/github-actions.yml`) runs on a Gitea runner whose jobs execute in ephemeral
containers, which cannot see the NAS unless the folder is bind-mounted into them. See the `home-server` repo
(`CLAUDE.md`, "Gitea & CI/CD") for how that mechanism works. For this project, the runner's `config.yaml` needs:

- `container.options`: `-v /mnt/nfs/volume1/video/kaleidoscope-media:/archive/kaleidoscope-media`
- `container.valid_volumes`: `/mnt/nfs/volume1/video/kaleidoscope-media` (without this entry the bind is silently dropped)

Before the first run, create the `wsg`, `gondola` and `comfy` folders on the NAS and run once without
`requireManifest` (or copy in an existing bucket mirror) so each has a manifest.

## Maintenance tools

One-off utilities that sit beside archivist. None of them run as part of `npm run start` or CI. (Bootstrapping an S3
manifest, `npm run seed-s3-manifest`, is covered under "Hash manifests".)

### Finding and removing near-duplicate videos and audio

Archivist de-dupes by md5, so the same video re-encoded (different quality, bitrate or container) is saved as a
separate file. Three tools find those and clean them up, in this order:

1. `tools/find_similar_media.py` scans a folder (read-only) and writes a report.
2. `tools/remove_similar_media.py` removes the duplicates and unreadable files it lists, from a folder.
3. `npm run prune-s3-from-report` removes the same files from S3.

**Requirements for the Python tools:** Python 3.9+, `ffmpeg` and `ffprobe` on the PATH, and `pip install numpy`.

#### 1. Scan

`python tools/find_similar_media.py <folder> -o duplicates.json`

Video and audio are fingerprinted and compared **separately**, so the report has one set of groups for each.
- Video: 10 frames at fixed relative positions through the file (5%, 15%, ... 95%), each shrunk to 9x8 greyscale and
  turned into a 64-bit difference hash.
- Audio: 10 two-second windows at the same positions, hashed from how energy in 8 frequency bands rises and falls
  (so volume changes don't matter). Silent audio is skipped.
- Two files match when their durations are within 2% and at least 80% of the sampled positions are within a
  bit-distance threshold. Matches are merged into groups, so a group can chain A~B~C.

Positions are relative to the duration, so a **trimmed or extended copy won't match**, and cropped or letterboxed copies
usually won't either. Tuning flags: `--video-bits` (10), `--audio-bits` (12), `--min-score` (0.8),
`--duration-tolerance` (0.02), `--workers`, `--no-recurse`.

A `.json` output is the report the other tools read (paths relative to the scanned folder, plus size, resolution and
bitrate). Any other extension gives a human-readable text report instead. Fingerprints are cached in
`<output>.cache.json` (or `--cache`), keyed by size and modification time, so re-running only processes new or changed
files. Files that `ffprobe` cannot read are listed as "unreadable".

#### 2. Remove from the folder

`python tools/remove_similar_media.py duplicates.json --root <folder>`

The report holds relative paths, so you can scan one copy (say, a local one) and apply the removal to another copy of
the same tree (say, the NAS) by pointing `--root` at it. It is a **dry run unless `--apply`** is given, and ends with a
summary by reason.

| Flag                | Effect                                                                                                      |
|---------------------|-------------------------------------------------------------------------------------------------------------|
| `--apply`           | Actually remove files.                                                                                      |
| `--quarantine DIR`  | Move removed files to `DIR` (subpaths kept) instead of deleting them.                                       |
| `--video-only`      | Remove video duplicates on a visual match alone. By default the audio must match too.                       |
| `--keep-unreadable` | Leave unreadable files alone. By default they are re-checked with `ffprobe` and removed if still unreadable. |

- **What counts as a duplicate:** a video file is removed only if it matches the group's keeper both visually and by
  audio. A visual match with different audio (a different dub, say) is kept and listed. If neither file has usable
  audio, the visual match alone is accepted and labelled as such. Audio-only files are removed on an audio match, and
  a video file is never removed because its soundtrack matched.
- **Which copy is kept:** for video, the highest resolution, then bitrate, then size. For audio, the highest bitrate,
  then size. Ties go to the shortest path.
- **Safeguards:** a file is only touched if it exists under `--root` with exactly the size recorded in the report, and
  a file that is the keeper of any group is never removed.

#### 3. Remove from S3

`npm run prune-s3-from-report -- --region us-east-1 --bucket kaleidoscope-media --nas //guff-nas/video/kaleidoscope-media --report duplicates.json`

This deliberately does **not** mirror the NAS. It only considers files named in the report, and of those it deletes
the ones that are now gone from the NAS. Each first-level subfolder is its own location (own manifest and index), matched
to the same subfolder name in S3. Add `--apply` to delete (dry run otherwise), and `--path` if the NAS folder
corresponds to a prefix inside the bucket instead of the bucket root. An object is deleted only when:

- the file is absent from the NAS, and its NAS subfolder has a `.archivist-manifest.json` (a subfolder without one,
  such as an unmounted share, is skipped and reported);
- for duplicates, another member of its group still exists on the NAS, so the last copy is never removed;
- the S3 object exists with the size recorded in the report.

Afterwards each affected location's S3 manifest has the deleted names removed, and its published index is rewritten
if it has one.

#### Things to know

- Deletes from S3 are permanent unless the bucket has versioning turned on (it did not when this was written), and
  the S3 tool has no quarantine. Read the dry run first.
- Removing a file also removes its hash from the manifest, so if a source still has that file, the next archivist run
  will save it again.
- The NAS manifests and published indexes are refreshed by the next archivist run against that folder. The S3 ones are
  updated by the prune tool.
- Keep the `.json` report: it is the record of what was removed and which copy was kept. The report, the cache and the
  text output are generated, and are not committed.
