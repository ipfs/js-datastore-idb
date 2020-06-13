'use strict'

const { Buffer } = require('buffer')
const { openDB, deleteDB } = require('idb')
const { Key, Errors, utils, Adapter } = require('interface-datastore')
const { filter, sortAll } = utils
const { default: PQueue } = require('p-queue')

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

class TaskQueue {
  constructor (store) {
    this._defaultStore = store
    this._tasks = []
  }

  push (task) {
    let ok
    let fail

    this._tasks.push(async (store) => {
      try {
        ok(await task(store))
      } catch (err) {
        if (err.message.includes('finished')) {
          try {
            return ok(await task(this._defaultStore))
          } catch (err) {
            return fail(err)
          }
        }

        fail(err)
      }
    })

    return new Promise((resolve, reject) => {
      ok = resolve
      fail = reject
    })
  }

  async drain (store) {
    while (this._tasks.length) {
      const task = this._tasks.shift()

      await task(store || this._defaultStore)
    }
  }
}

class IdbDatastore extends Adapter {
  constructor (location, options = {}) {
    super()

    this.store = null
    this.options = options
    this.location = (options.prefix || '') + location
    this.version = options.version || 1

    this.transactionQueue = new PQueue({ concurrency: 1 })
    this._lastTransactionFinished = null
  }

  _getStore () {
    if (this.store === null) {
      throw new Error('Datastore needs to be opened.')
    }

    return this.transactionQueue.add(async () => {
      await this._lastTransactionFinished

      let next

      this._lastTransactionFinished = new Promise(resolve => {
        next = () => {
          // not using this transaction any more
          this._tx = null
          resolve()
        }
      })

      this._tx = this.store.transaction('readwrite')
      this._tx.oncomplete = () => {
        if (this._tx) {
          this._tx.active = false
        }
      }
      this._tx.onerror = () => {
        if (this._tx) {
          this._tx.active = false
        }
      }
      this._tx.onabort = () => {
        if (this._tx) {
          this._tx.active = false
        }
      }

      return {
        store: this._tx.store,
        done: next
      }
    })
  }

  async * _queryIt (q) {
    const range = q.prefix ? self.IDBKeyRange.bound(str2ab(q.prefix), str2ab(q.prefix + '\xFF'), false, true) : undefined
    const {
      store,
      done
    } = await this._getStore()

    try {
      let cursor = await store.openCursor(range)

      let limit = 0

      if (cursor && q.offset && q.offset > 0) {
        cursor = await cursor.advance(q.offset)
      }

      while (cursor) {
        // the transaction is only active *after* we've opened the cursor, so stop any interleaved
        // read/writes from encountering 'transaction is not active' errors while we open the cursor.
        // Sigh. This is why we can't have nice things.
        this._tx.active = true

        // process any requests that occured while the cursor was moving
        await this.taskQueue.drain(store)

        // limit
        if (q.limit !== undefined && q.limit === limit) {
          break
        }
        limit++

        const key = new Key(Buffer.from(cursor.key))
        let value

        if (!q.keysOnly) {
          value = Buffer.from(cursor.value)
        }

        if (q.keysOnly) {
          yield { key }
        } else {
          yield { key, value }
        }

        // the transaction can end before the cursor promise has resolved
        this._tx.active = false
        cursor = await cursor.continue()
      }

      await this.taskQueue.drain()
    } finally {
      done()
    }
  }

  async open () {
    if (this.store !== null) {
      return
    }

    const location = this.location
    try {
      const store = await openDB(location, this.version, {
        upgrade (db) {
          db.createObjectStore(location)
        }
      })

      // this store requires a `location` arg but the transaction stores
      // do not so make the API the same
      this.store = {
        get: (key) => store.get(location, key),
        getKey: (key) => store.getKey(location, key),
        put: (key, value) => store.put(location, key, value),
        delete: (key) => store.delete(location, key),
        transaction: (type) => store.transaction(location, type),
        close: () => store.close()
      }
    } catch (err) {
      throw Errors.dbOpenFailedError(err)
    }

    this.taskQueue = new TaskQueue(this.store)
  }

  async put (key, val) {
    if (this.store === null) {
      throw new Error('Datastore needs to be opened.')
    }

    try {
      if (this._tx) {
        if (this._tx.active) {
          await this._tx.store.put(val, key.toBuffer())
        } else {
          await this.taskQueue.push((store) => store.put(val, key.toBuffer()))
        }
      } else {
        await this.store.put(val, key.toBuffer())
      }
    } catch (err) {
      if (err.name === 'TransactionInactiveError') {
        await this.taskQueue.push((store) => store.put(val, key.toBuffer()))
      } else {
        throw Errors.dbWriteFailedError(err)
      }
    }
  }

  async get (key) {
    if (this.store === null) {
      throw new Error('Datastore needs to be opened.')
    }

    let value
    try {
      if (this._tx) {
        if (this._tx.active) {
          value = await this._tx.store.get(key.toBuffer())
        } else {
          value = await this.taskQueue.push((store) => store.get(key.toBuffer()))
        }
      } else {
        value = await this.store.get(key.toBuffer())
      }
    } catch (err) {
      if (err.name === 'TransactionInactiveError') {
        value = await this.taskQueue.push((store) => store.get(key.toBuffer()))
      } else {
        throw Errors.dbWriteFailedError(err)
      }
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

    let res

    try {
      if (this._tx) {
        if (this._tx.active) {
          res = await this._tx.store.getKey(key.toBuffer())
        } else {
          res = await this.taskQueue.push((store) => store.getKey(key.toBuffer()))
        }
      } else {
        res = await this.store.getKey(key.toBuffer())
      }
    } catch (err) {
      if (err.name === 'TransactionInactiveError') {
        res = await this.taskQueue.push((store) => store.getKey(key.toBuffer()))
      } else if (err.code === 'ERR_NOT_FOUND') {
        return false
      } else {
        throw err
      }
    }

    return Boolean(res)
  }

  async delete (key) {
    if (this.store === null) {
      throw new Error('Datastore needs to be opened.')
    }

    try {
      if (this._tx) {
        if (this._tx.active) {
          await this._tx.store.delete(key.toBuffer())
        } else {
          await this.taskQueue.push((store) => store.delete(key.toBuffer()))
        }
      } else {
        await this.store.delete(key.toBuffer())
      }
    } catch (err) {
      if (err.name === 'TransactionInactiveError') {
        await this.taskQueue.push((store) => store.delete(key.toBuffer()))
      } else {
        throw Errors.dbDeleteFailedError(err)
      }
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
        const {
          store,
          done
        } = await this._getStore()

        try {
          this._tx.active = true

          // process any requests that occured while the transaction was opening
          await this.taskQueue.drain(store)

          await Promise.all(puts.map(p => store.put(p[1], p[0])))
          await Promise.all(dels.map(p => store.delete(p)))

          await this.taskQueue.drain(store)
        } finally {
          done()
        }
      }
    }
  }

  query (q) {
    let it = this._queryIt(q)

    if (Array.isArray(q.filters)) {
      it = q.filters.reduce((it, f) => filter(it, f), it)
    }

    if (Array.isArray(q.orders)) {
      it = q.orders.reduce((it, f) => sortAll(it, f), it)
    }

    return it
  }

  async close () {
    if (this._tx) {
      await this._tx.done
    }

    if (this.store) {
      this.store.close()
      this.store = null
    }
  }

  destroy () {
    return deleteDB(this.location)
  }
}

module.exports = IdbDatastore
