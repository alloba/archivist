import crypto from "crypto";

export default class FileUtils {
    public static getUniqueName(filename: string): string {
        const shortname = filename.substring(0, filename.lastIndexOf('.')).replace(/[^a-zA-Z0-9-_]/g, '') //the regex is trying to make filenames sane. stuff starts breaking with fancy cyrillic or whatever
        const timestamp = new Date().getTime()
        return shortname + '_' + timestamp + '.' + filename.split('.').pop()
    }

    public static getMd5(rawfile: Buffer): string {
        return crypto.createHash('md5').update(rawfile).digest('hex')
    }
}
