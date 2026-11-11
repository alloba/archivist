import FileMeta from "../model/FileMeta.js";

export interface DestinationInterface {
    saveMedia: SaveMediaFunction
    getExistingMeta: GetExistingMetaFunction

    /** Optional hook, called once at the end of a run (even a failed one) to flush any cached state. */
    close?: CloseFunction
}

interface SaveMediaFunction {
    /**
     * `filename` is the name to save under. When saving to several destinations, the caller picks one name and gives
     * it to all of them, so every destination ends up with identical filenames. If omitted, the destination makes up
     * a unique name itself.
     */
    (filemeta: FileMeta, rawfilepromise: Promise<Buffer>, filename?: string): Promise<void>
}

interface GetExistingMetaFunction {
    (): Promise<FileMeta[]>
}

interface CloseFunction {
    (): Promise<void>
}
