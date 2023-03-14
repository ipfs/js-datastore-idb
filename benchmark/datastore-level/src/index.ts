/* eslint-disable no-console */

import { Bench } from 'tinybench'
import { IDBDatastore } from 'datastore-idb'
import { LevelDatastore } from 'datastore-level'
import { Key } from 'interface-datastore'

const RESULT_PRECISION = 2

async function main (): Promise<void> {
  console.info('simple put')

  const suite = new Bench()
  suite.add('level', async () => {
    const store = new LevelDatastore('hello2')
    await store.open()
    await store.put(new Key('/z/one'), Uint8Array.from([0, 1, 2, 3, 4]))
    await store.close()
  })
  suite.add('idb', async () => {
    const store = new IDBDatastore('hello2')
    await store.open()
    await store.put(new Key('/z/one'), Uint8Array.from([0, 1, 2, 3, 4]))
    await store.close()
  })

  await suite.run()

  console.table(suite.tasks.sort((a, b) => { // eslint-disable-line no-console
    const resultA = a.result?.hz ?? 0
    const resultB = b.result?.hz ?? 0

    if (resultA === resultB) {
      return 0
    }

    if (resultA < resultB) {
      return 1
    }

    return -1
  }).map(({ name, result }) => ({
    Implementation: name,
    'ops/s': parseFloat(result?.hz.toFixed(RESULT_PRECISION) ?? '0'),
    'ms/op': parseFloat(result?.period.toFixed(RESULT_PRECISION) ?? '0'),
    runs: result?.samples.length
  })))
}


main().catch(err => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})
