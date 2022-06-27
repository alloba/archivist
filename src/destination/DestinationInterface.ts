import FileMeta from "../model/FileMeta.js";

export interface DestinationInterface {
    saveMedia: SaveMediaFunction
    getExistingMeta: GetExistingMetaFunction
}

interface SaveMediaFunction {
    (filemeta: FileMeta, rawfilepromise: Promise<Buffer>): Promise<void>
}

interface GetExistingMetaFunction {
    (): Promise<FileMeta[]>
}
