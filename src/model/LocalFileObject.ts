class LocalFileObject {
    filename: string
    ext: string
    md5: string
    raw: Buffer //TODO: not sure if this is the right type.

    constructor(filename: string, extension: string, md5: string, raw: Buffer) {
        this.filename = filename
        this.ext = extension
        this.md5 = md5
        this.raw = raw
    }
}
