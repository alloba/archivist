export default class FileMeta {
    uri: string
    md5: string
    name: string
    extension: string

    constructor(name:string, uri: string, extension:string, md5: string) {
        this.uri = uri
        this.md5 = md5
        this.name = name
        this.extension = extension
    }
}
