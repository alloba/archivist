import FileMeta from "../model/FileMeta.js";

export interface SourceInterface {
    scanForMetadata: ScanForMetadataFunction
    downloadFile: DownloadFileFunction
}

interface ScanForMetadataFunction {
    (): Promise<Array<FileMeta>>
}

interface DownloadFileFunction {
    (filemeta: FileMeta): Promise<Buffer>
}
