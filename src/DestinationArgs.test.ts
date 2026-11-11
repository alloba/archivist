import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import minimist from 'minimist'
import {parseDestinationArgs} from './DestinationArgs.js'

const parse = (argv: string[]) => parseDestinationArgs(minimist(argv).destination)

describe('parseDestinationArgs', () => {
    it('treats the original single-destination form as a list of one', () => {
        const result = parse(['--destination.type', 's3', '--destination.bucket', 'b'])
        assert.deepEqual(result, [{type: 's3', bucket: 'b'}])
    })

    it('splits indexed destinations, keeping each one\'s args separate', () => {
        const result = parse([
            '--destination.0.type', 's3', '--destination.0.path', 'wsg',
            '--destination.1.type', 'fs', '--destination.1.path', '/mnt/wsg',
        ])
        assert.deepEqual(result, [{type: 's3', path: 'wsg'}, {type: 'fs', path: '/mnt/wsg'}])
    })

    it('orders indexed destinations numerically, not lexically', () => {
        const argv = []
        for (const i of [10, 2, 1]) argv.push(`--destination.${i}.type`, `t${i}`)
        assert.deepEqual(parse(argv).map(x => x.type), ['t1', 't2', 't10'])
    })

    it('rejects mixing indexed and non-indexed arguments', () => {
        assert.throws(() => parse(['--destination.type', 's3', '--destination.1.type', 'fs']), /Cannot mix/)
    })

    it('rejects a missing destination', () => {
        assert.throws(() => parseDestinationArgs(undefined), /destination/)
    })
})
