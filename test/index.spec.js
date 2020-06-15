/* eslint-env mocha */
'use strict'

const { MountDatastore } = require('datastore-core')
const { Key } = require('interface-datastore')
const { isNode } = require('ipfs-utils/src/env')
const IDBStore = require('../src')

describe('IndexedDB Datastore', function () {
  if (isNode) {
    return
  }
  describe('interface-datastore (idb)', () => {
    const store = new IDBStore('hello')
    require('interface-datastore/src/tests')({
      setup: async () => {
        await store.open()
        return store
      },
      teardown: () => {
        return store.destroy()
      }
    })
  })

  describe('interface-datastore (mount(idb, idb, idb))', () => {
    const one = new IDBStore('one')
    const two = new IDBStore('two')
    const three = new IDBStore('three')
    require('interface-datastore/src/tests')({
      async setup () {
        const d = new MountDatastore([
          {
            prefix: new Key('/a'),
            datastore: one
          },
          {
            prefix: new Key('/q'),
            datastore: two
          },
          {
            prefix: new Key('/z'),
            datastore: three
          }
        ])
        await d.open()
        return d
      },
      teardown () {
        return Promise.all([one.destroy(), two.destroy(), three.destroy()])
      }
    })
  })

  describe.only('concurrency', () => {
    let store

    before(async () => {
      store = new IDBStore('hello')
      await store.open()
    })

    it('should not explode under unreasonable load', function (done) {
      this.timeout(10000)

      const updater = setInterval(async () => {
        try {
          const key = new Key('/a-' + Date.now())

          await store.put(key, Buffer.from([0, 1, 2, 3]))
          await store.has(key)
          await store.get(key)
        } catch (err) {
          clearInterval(updater)
          clearInterval(mutatorQuery)
          clearInterval(readOnlyQuery)
          done(err)
        }
      }, 0)

      const mutatorQuery = setInterval(async () => {
        try {
          for await (const { key } of store.query({})) {
            await store.get(key)

            const otherKey = new Key('/b-' + Date.now())
            const otherValue = Buffer.from([0, 1, 2, 3])
            await store.put(otherKey, otherValue)
            const res = await store.get(otherKey)
            expect(res).to.deep.equal(otherValue)
          }
        } catch (err) {
          clearInterval(updater)
          clearInterval(mutatorQuery)
          clearInterval(readOnlyQuery)
          done(err)
        }
      }, 0)

      const readOnlyQuery = setInterval(async () => {
        try {
          for await (const { key } of store.query({})) {
            await store.has(key)
          }
        } catch (err) {
          clearInterval(updater)
          clearInterval(mutatorQuery)
          clearInterval(queryier)
          done(err)
        }
      }, 0)

      setTimeout(() => {
        clearInterval(updater)
        clearInterval(mutatorQuery)
        clearInterval(readOnlyQuery)
        done()
      }, 5000)
    })
  })
})
