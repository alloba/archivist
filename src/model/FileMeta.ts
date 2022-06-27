export default class FileMeta {
    uri: string
    md5: string
    name: string
    extension: string

    // this is just to accommodate 4chan meta information. Other sources should make no use of it.
    // this is the key that is used to reference an image file directly via their api.
    // tim = time + microseconds
    tim: number

    constructor(name: string, uri: string, extension: string, md5: string, tim:number=0) {
        this.uri = uri
        this.md5 = md5
        this.name = name
        this.extension = extension
        this.tim = tim
    }
}
