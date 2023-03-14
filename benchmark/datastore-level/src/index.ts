/* eslint-disable no-console */

import { Bench } from 'tinybench'
import { IDBDatastore } from 'datastore-idb'
import { LevelDatastore } from 'datastore-level'
import { Key } from 'interface-datastore'

const RESULT_PRECISION = 2
const BLOCKS = 1000

async function testPut (): Promise<void> {
  console.info('simple put')

  const suite = new Bench({
    iterations: 1
  })
  suite.add('level put', async () => {
    for (let i = 0; i < BLOCKS; i++) {
      // @ts-expect-error
      await this.store.put(new Key(`/z/block-${i}`), Uint8Array.from([0, 1, 2, 3, 4, i]))
    }
  }, {
    async beforeEach () {
      // @ts-expect-error
      this.store = new LevelDatastore('hello-level-put')
      // @ts-expect-error
      await this.store.open()
    },
    async afterEach () {
      // @ts-expect-error
      await this.store.close()
    }
  })
  suite.add('idb put', async () => {
    for (let i = 0; i < BLOCKS; i++) {
      // @ts-expect-error
      await store.put(new Key(`/z/block-${i}`), Uint8Array.from([0, 1, 2, 3, 4, i]))
    }
  }, {
    async beforeEach () {
      // @ts-expect-error
      this.store = new IDBDatastore('hello-idb-put')
      // @ts-expect-error
      await this.store.open()
    },
    async afterEach () {
      // @ts-expect-error
      await this.store.close()
    }
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

async function testGet (): Promise<void> {
  console.info('simple get')

  const suite = new Bench({
    iterations: 1
  })
  suite.add('level get', async () => {
    for (let i = 0; i < BLOCKS; i++) {
      // @ts-expect-error
      await this.store.get(new Key(`/z/block-${i}`))
    }
  }, {
    async beforeEach () {
      // @ts-expect-error
      this.store = new LevelDatastore('hello-level-get')

      for (let i = 0; i < BLOCKS; i++) {
        // @ts-expect-error
        await this.store.put(new Key(`/z/block-${i}`), Uint8Array.from([0, 1, 2, 3, 4, i]))
      }

      // @ts-expect-error
      await this.store.open()
    },
    async afterEach () {
      // @ts-expect-error
      await this.store.close()
    }
  })
  suite.add('idb get', async () => {
    for (let i = 0; i < BLOCKS; i++) {
      // @ts-expect-error
      await this.store.get(new Key(`/z/block-${i}`))
    }
  }, {
    async beforeEach () {
      // @ts-expect-error
      this.store = new IDBDatastore('hello-idb-get')

      for (let i = 0; i < BLOCKS; i++) {
        // @ts-expect-error
        await this.store.put(new Key(`/z/block-${i}`), Uint8Array.from([0, 1, 2, 3, 4, i]))
      }

      // @ts-expect-error
      await this.store.open()
    },
    async afterEach () {
      // @ts-expect-error
      await this.store.close()
    }
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

async function main () {
  await testPut()
  await testGet()
}

main().catch(err => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})
