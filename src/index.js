'use strict'

const { Buffer } = require('buffer')
const { Key, Errors, utils } = require('interface-datastore')
const { filter, sortAll } = utils

const { openDB, deleteDB } = require('idb')

function isStrictTypedArray (arr) {
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

function typedarrayToBuffer (arr) {
  if (isStrictTypedArray(arr)) {
    // To avoid a copy, use the typed array's underlying ArrayBuffer to back new Buffer
    var buf = Buffer.from(arr.buffer)
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

class IdbDatastore {
  constructor (location) {
    this.location = location
    this.store = null
  }

  async open () {
    const location = this.location
    try {
      this.store = await openDB(this.location, 1, {
        upgrade (db) {
          db.createObjectStore(location)
        }
      })
    } catch (err) {
      throw Errors.dbOpenFailedError(err)
    }
  }

  async put (key, val) {
    if (this.store === null) {
      throw new Error('Datastore needs to be opened.')
    }
    try {
      await this.store.put(this.location, val, key.toBuffer())
    } catch (err) {
      throw Errors.dbWriteFailedError(err)
    }
  }

  async get (key) {
    if (this.store === null) {
      throw new Error('Datastore needs to be opened.')
    }
    let value
    try {
      value = await this.store.get(this.location, key.toBuffer())
    } catch (err) {
      throw Errors.dbWriteFailedError(err)
    }

    if (!value) {
      throw Errors.notFoundError()
    }

    return typedarrayToBuffer(value)
  }

  async has (key) {
    if (this.store === null) {
      throw new Error('Datastore needs to be opened.')
    }
    try {
      await this.get(key)
    } catch (err) {
      if (err.code === 'ERR_NOT_FOUND') return false
      throw err
    }
    return true
  }

  async delete (key) {
    if (this.store === null) {
      throw new Error('Datastore needs to be opened.')
    }
    try {
      await this.store.delete(this.location, key.toBuffer())
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
        if (this.store === null) {
          throw new Error('Datastore needs to be opened.')
        }
        const tx = this.store.transaction(this.location, 'readwrite')
        const store = tx.store
        await Promise.all(puts.map(p => store.put(p[1], p[0])))
        await Promise.all(dels.map(p => store.delete(p)))
        await tx.done
      }
    }
  }

  query (q) {
    if (this.store === null) {
      throw new Error('Datastore needs to be opened.')
    }
    let limit = 0

    let it = (async function * (store, location) {
      let cursor = await store.transaction(location).store.openCursor()

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
        const value = Buffer.from(cursor.value)
        if (!q.prefix || (q.prefix && key.toString().startsWith(q.prefix))) {
          if (q.keysOnly) {
            yield { key }
          } else {
            yield { key, value }
          }
        }
        cursor = await cursor.continue()
      }
    })(this.store, this.location)

    if (Array.isArray(q.filters)) {
      it = q.filters.reduce((it, f) => filter(it, f), it)
    }

    if (Array.isArray(q.orders)) {
      it = q.orders.reduce((it, f) => sortAll(it, f), it)
    }

    return it
  }

  close () {
    if (this.store === null) {
      throw new Error('Datastore needs to be opened.')
    }
    return this.store.close()
  }

  destroy () {
    return deleteDB(this.location)
  }
}

module.exports = IdbDatastore
