import {SourceInterface} from "./SourceInterface.js";
import FileMeta from "../model/FileMeta.js";
import Bottleneck from "bottleneck";
import fetch from "node-fetch";

export class ChanSource implements SourceInterface {
    dataDomain = 'https://a.4cdn.org';
    contentDomain = 'https://i.4cdn.org';
    targetBoard: string
    searchTerm: string
    limiter: Bottleneck

    constructor(sourceargs: any) {
        if (!sourceargs) {
            this.printHelp()
            throw Error('Missing or undefined sourceargs found during initialization of ChanSource')
        }
        if (!sourceargs.path) {
            this.printHelp()
            throw Error('Missing required argument for source initialization :: ' + 'source.path (board name)')
        }
        if (!sourceargs.search) {
            this.printHelp()
            throw Error('Missing required argument for source initialization :: ' + 'source.search')
        }

        this.targetBoard = sourceargs.path.toLowerCase()
        this.searchTerm = sourceargs.search
        this.limiter = new Bottleneck({minTime: 1000, maxConcurrent: 1})
        console.log('4Chan source has been initialized. Api operations are throttled to 1/second.')
        console.log(`Target Board: ${this.targetBoard}\nSearch Term: ${this.searchTerm}\n`)
    }

    public printHelp(): void {
        console.log(
            `
            Required parameters for 4ChanSource: 
                destination.path   - The board to use. wsg/gif/etc.
                destination.search - The search term to use while looking for threads. 
                                     The term only has to exist within the thread title, it does not have to be a full match. 
            `
        )
    }

    public async scanForMetadata(): Promise<FileMeta[]> {
        console.log('Loading target board :: ' + this.targetBoard)
        const board = await this.getBoardCatalog() as Array<any>

        console.log('Querying for threads in board.')
        const allThreads = board.flatMap(x => x.threads)
        console.log(`${allThreads.length} threads found on the board.`)

        const targetThreads = allThreads.filter(x => x.sub && x.sub.toLowerCase().includes(this.searchTerm.toLowerCase()))
        console.log(`Search term filter applied. Removed ${allThreads.length - targetThreads.length} threads that did not match criteria. (${targetThreads.length} remain)`)

        console.log('Loading all thread details.')
        const threadDetails = await Promise.all(targetThreads.flatMap(async x => this.getThreadDetail(x.no)))

        console.log('Processed meta information for all located files in threads.')
        console.log()
        return threadDetails.flatMap(x => this.getAllImageMetasInThread(x))
    }

    public async downloadFile(filemeta: FileMeta): Promise<Buffer> {
        if (filemeta.tim == 0) {
            throw Error('Invalid tim given. Is this meta object originated from a different initial source?')
        }
        const fileraw = await this.limiter.schedule(() => fetch(filemeta.uri, {}))
        return Buffer.from(await fileraw.arrayBuffer()); //raw buffer for the image file... this will explode if you accidentally pull a non-binary file from the above call.
    }

    /**
     * [
     *     {
     *         "page": 1,
     *         "threads": [
     *             {
     *                 "no": 957536,
     *                 "sticky": 1,
     *                 "closed": 1,
     *                 "now": "02/20/16(Sat)17:18:07",
     *                 "name": "Anonymous",
     *                 "sub": "Welcome to /wsg/",
     *                 "com": "1. Please check the Catalog before you post. Popular topics and themes relating to TV shows, people, etc., may already have active threads.<br>\n2. Please contribute 3 or more related images when starting a thread.<br>\n3. If you know the source of a given image, please provide it in the post.<br>\n4. Original content is encouraged, and &#039;filename threads&#039;, post your Xth gif threads are welcome.<br>\n5. Remember this is a Work Safe board and Global Rule 5 applies!<br>\n<br>\n\n<a href=\"http://i.imgur.com/JJnLJZx.gif\">/gif/ guide to creating animated gifs</a><br>\n<br>\nOther helpful links:<br>\n<a href=\"http://www.video-gif-converter.com/index.html\">http://www.video-gif-converter.com/<wbr>index.html</a><br>\n<a href=\"http://www.wikihow.com/Make-an-Animated-GIF-from-a-Video-in-Photoshop-CS5\">http://www.wikihow.com/Make-an-Anim<wbr>ated-GIF-from-a-Video-in-Photoshop-<wbr>CS5</a>",
     *                 "time": 1456006687,
     *                 "resto": 0,
     *                 "capcode": "mod",
     *                 "semantic_url": "welcome-to-wsg",
     *                 "replies": 2,
     *                 "images": 0,
     *                 "omitted_posts": 1,
     *                 "omitted_images": 0,
     *                 "last_replies": [
     *                     {
     *                         "no": 2975263,
     *                         "now": "08/01/19(Thu)11:19:52",
     *                         "name": "Anonymous",
     *                         "com": "Current limits for WebM files on 4chan are:<br>Maximum file size is 6144KB.<br>Maximum duration is 300 seconds.<br>Maximum resolution is 2048x2048 pixels.<br><br>Click here to see a detailed guide on how to create webm files.<br><br>You can now upload webm files with sound to /wsr/. Please post all requests there.<br><br><a href=\"//boards.4channel.org/wsr/\" class=\"quotelink\">&gt;&gt;&gt;/wsr/</a>",
     *                         "time": 1564672792,
     *                         "resto": 957536,
     *                         "capcode": "mod"
     *                     }
     *                 ],
     *                 "last_modified": 1564672800
     *             }
     *         ]
     *     }
     * ]
     */
    private async getBoardCatalog(): Promise<any> {
        return await this.limiter.schedule(() =>
            fetch(`${this.dataDomain}/${this.targetBoard}/catalog.json`, {}).then(res => res.json())
        )
    }

    /**
     *
     * {
     *     "posts": [
     *         {
     *             "no": 4543889,
     *             "now": "05/26/22(Thu)22:48:53",
     *             "name": "Anonymous",
     *             "com": "<a href=\"#p4543510\" class=\"quotelink\">&gt;&gt;4543510</a><br>Is it just me or dogs never take cats seriously? Like here for example, the cat is actually pissed but for the dog is just a game. <br>Also what breed is that? <br>Sry I don&#039;t have a dog webm so here is a horse instead.",
     *             "filename": "vulgar display of horsepower",
     *             "ext": ".webm",
     *             "w": 240,
     *             "h": 240,
     *             "tn_w": 125,
     *             "tn_h": 125,
     *             "tim": 1653619733613,
     *             "time": 1653619733,
     *             "md5": "0jPXplmOt3sISvTHnMEzww==",
     *             "fsize": 5731980,
     *             "resto": 4543456
     *         },
     *         ...
     *     ]
     * }
     *
     * @param threadNo thread id to operate on
     */
    private async getThreadDetail(threadNo: string): Promise<any> {
        console.log(`Grabbing thread details for ${this.targetBoard}/${threadNo}`)
        return await this.limiter.schedule(() =>
            fetch(`${this.dataDomain}/${this.targetBoard}/thread/${threadNo}.json`, {}).then(res => res.json())
        );
    }

    private getAllImageMetasInThread(threadObject: any): FileMeta[] {
        if (!threadObject.posts) {
            throw Error('Invalid post object being operated upon. Dying.')
        }
        const posts = threadObject.posts as Array<any>
        return posts
            .filter(x => x.filename)
            .filter(x => x.ext)
            .filter(x => ['.webm'].includes(x.ext)) //TODO: this will probably never change away from just being webm. but if it does then maybe a big blinking todo will make it easier to locate the problem.
            .filter(x => x.md5)
            .map(x => new FileMeta(
                    x.filename + x.ext,
                    `${this.contentDomain}/${this.targetBoard}/${x.tim}${x.ext}`,
                    x.ext,
                    this.convertMd5ToHex(x.md5),
                    x.tim
                )
            )
    }

    /**
     * 4Chan stores it's md5 information as base64, while I'm generally targeting (and S3 uses) hex.
     *
     * @param hash base64 hash
     * @private
     */
    private convertMd5ToHex(hash: string) {
        if (!hash.endsWith('==')) {
            throw Error('Cannot convert provided hash to hex. Incorrect encoding. :: ' + hash)
        }
        const buffer = Buffer.from(hash, 'base64')
        return buffer.toString('hex')
    }
}
