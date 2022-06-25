interface MediaDestinationInterface {
    name: string // human-readable name of the media destination object
    description: string // description of the destination object
    type: string // unique source type for this class. (s3/fs/etc)

    path: string // subpath that is meant to be used for scans on this source

    verifyParamsFunction: MediaDestinationVerifyParamsFunc
    listAllMediaFunction: MediaDestinationListAllMediaFunc
    findMediaByHashFunction: MediaDestinationFindByHashFunc
    saveMediaFunction: MediaDestinationSaveFunc
}

interface MediaDestinationEntry {
    path: string
    meta: object
    getHashFunction: MediaDestinationEntryGetHashFunc
}

interface MediaDestinationVerifyParamsFunc {
    (): void
}

interface MediaDestinationListAllMediaFunc {
    (): Array<MediaDestinationEntry>
}

interface MediaDestinationFindByHashFunc {
    (hash: string): MediaDestinationEntry
}

interface MediaDestinationSaveFunc {
    (mediaResult: MediaSearchResult): void
}

interface MediaDestinationEntryGetHashFunc {
    (entry: MediaDestinationEntry): string
}
