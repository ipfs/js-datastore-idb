'use strict'

const { Buffer } = require('buffer')
const { openDB, deleteDB } = require('idb')
const { Key, Errors, utils, Adapter } = require('interface-datastore')
const { filter, sortAll } = utils

const isStrictTypedArray = (arr) => {
  return (
    arr instanceof Int8Array ||
    arr instanceof Int16Array ||
    arr instanceof Int32Array ||
    arr instanceof Uint8Array ||
    arr instanceof Uint8ClampedArray ||
    arr instanceof Uint16Array ||
    arr instanceof Uint32Array ||
    arr instanceof Float32Array ||
    arr instanceof Float64Array
  )
}

const typedarrayToBuffer = (arr) => {
  if (isStrictTypedArray(arr)) {
    // To avoid a copy, use the typed array's underlying ArrayBuffer to back new Buffer
    let buf = Buffer.from(arr.buffer)
    if (arr.byteLength !== arr.buffer.byteLength) {
      // Respect the "view", i.e. byteOffset and byteLength, without doing a copy
      buf = buf.slice(arr.byteOffset, arr.byteOffset + arr.byteLength)
    }
    return buf
  } else {
    // Pass through all other types to `Buffer.from`
    return Buffer.from(arr)
  }
}

const str2ab = (str) => {
  const buf = new ArrayBuffer(str.length)
  const bufView = new Uint8Array(buf)
  for (let i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i)
  }
  return buf
}

const queryIt = async function * (q, instance) {
  const { db, location } = instance
  const range = q.prefix ? self.IDBKeyRange.bound(str2ab(q.prefix), str2ab(q.prefix + '\xFF'), false, true) : undefined
  const tx = db.transaction(location, 'readwrite')
  const store = tx.objectStore(location)
  let cursor = await store.openCursor(range)
  let limit = 0

  instance.tx = tx

  if (cursor && q.offset && q.offset > 0) {
    cursor = await cursor.advance(q.offset)
  }

  while (cursor) {
    // limit
    if (q.limit !== undefined && q.limit === limit) {
      return
    }
    limit++

    const key = new Key(Buffer.from(cursor.key))
    if (q.keysOnly) {
      yield { key }
    } else {
      const value = Buffer.from(cursor.value)
      yield { key, value }
    }
    cursor = await cursor.continue()
  }
  instance.tx = null
}

class IdbDatastore extends Adapter {
  constructor (location, options = {}) {
    super()

    this.db = null
    this.options = options
    this.location = (options.prefix || '') + location
    this.version = options.version || 1
    /** @type {IDBTransaction} */
    this.tx = null
  }

  getStore (mode) {
    if (this.db === null) {
      throw new Error('Datastore needs to be opened.')
    }

    if (this.tx) {
      return this.tx.objectStore(this.location)
    }

    return this.db.transaction(this.location, mode).objectStore(this.location)
  }

  async open () {
    if (this.db !== null) {
      return
    }

    const location = this.location
    try {
      this.db = await openDB(this.location, this.version, {
        upgrade (db) {
          db.createObjectStore(location)
        }
      })
    } catch (err) {
      throw Errors.dbOpenFailedError(err)
    }
  }

  async put (key, val) {
    try {
      await this.getStore('readwrite').put(val, key.toBuffer())
    } catch (err) {
      throw Errors.dbWriteFailedError(err)
    }
  }

  async get (key) {
    let value
    try {
      value = await this.getStore().get(key.toBuffer())
    } catch (err) {
      throw Errors.dbWriteFailedError(err)
    }

    if (!value) {
      throw Errors.notFoundError()
    }

    return typedarrayToBuffer(value)
  }

  /**
   * Check if a key exists in the datastore
   *
   * @param {Key} key
   * @returns {boolean}
   */
  async has (key) {
    let value
    try {
      value = await this.getStore().getKey(key.toBuffer())
    } catch (err) {
      throw Errors.dbWriteFailedError(err)
    }

    if (!value) {
      return false
    }
    return true
  }

  async delete (key) {
    try {
      await this.getStore('readwrite').delete(key.toBuffer())
    } catch (err) {
      throw Errors.dbDeleteFailedError(err)
    }
  }

  batch () {
    const puts = []
    const dels = []

    return {
      put (key, value) {
        puts.push([key.toBuffer(), value])
      },
      delete (key) {
        dels.push(key.toBuffer())
      },
      commit: async () => {
        if (this.db === null) {
          throw new Error('Datastore needs to be opened.')
        }
        const tx = this.db.transaction(this.location, 'readwrite')
        const store = tx.store
        await Promise.all(puts.map(p => store.put(p[1], p[0])))
        await Promise.all(dels.map(p => store.delete(p)))
        await tx.done
      }
    }
  }

  query (q) {
    if (this.db === null) {
      throw new Error('Datastore needs to be opened.')
    }
    let it = queryIt(q, this)

    if (Array.isArray(q.filters)) {
      it = q.filters.reduce((it, f) => filter(it, f), it)
    }

    if (Array.isArray(q.orders)) {
      it = q.orders.reduce((it, f) => sortAll(it, f), it)
    }

    return it
  }

  close () {
    if (this.db === null) {
      throw new Error('Datastore needs to be opened.')
    }
    this.db.close()
    this.db = null
  }

  destroy () {
    return deleteDB(this.location)
  }
}

module.exports = IdbDatastore
