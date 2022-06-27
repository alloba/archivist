export class BoardCatalog {
    page: number = 0
    threads: BoardCatalog_Thread[] = []
}

class BoardCatalog_Thread {
    no: number = 0
    name: string = ''
    sub: string = ''
    filename: string = ''
    ext: string = ''
    tim: number = 0
    md5: string = ''
    //many other fields i do not care about.
}
