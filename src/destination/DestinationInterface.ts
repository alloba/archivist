import FileMeta from "../model/FileMeta.js";

export interface DestinationInterface {
    saveMedia: SaveMediaFunction
    getExistingMeta: GetExistingMetaFunction

    /** Optional hook, called once at the end of a run (even a failed one) to flush any cached state. */
    close?: CloseFunction
}

interface SaveMediaFunction {
    (filemeta: FileMeta, rawfilepromise: Promise<Buffer>): Promise<void>
}

interface GetExistingMetaFunction {
    (): Promise<FileMeta[]>
}

interface CloseFunction {
    (): Promise<void>
}
