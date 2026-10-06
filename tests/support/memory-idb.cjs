/* Test-only, deliberately limited in-memory IndexedDB double.
 * Supports only the APIs used by this project; NOT a browser conformance test.
 * Serializes transactions and models atomic commit/abort and asynchronous requests.
 * Not referenced by index.html or service-worker.js.
 */
(function (root) {
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const later = fn => typeof setImmediate === 'function' ? setImmediate(fn) : setTimeout(fn, 0);
  const names = iterable => {
    const a = [...iterable]; a.contains = name => a.includes(name); return a;
  };
  class MemoryIDB {
    constructor() { this.databases = new Map(); this.failNextPutStore = null; }
    open(name, version = 1) {
      const req = {};
      later(() => {
        let db = this.databases.get(name);
        const oldVersion = db?.version || 0;
        if (oldVersion > version) { req.error = new Error('VersionError'); req.onerror?.({ target: req }); return; }
        if (!db) { db = new Database(this, name, version); this.databases.set(name, db); }
        req.result = db;
        if (oldVersion < version) {
          db.version = version;
          req.transaction = { objectStore: n => db._schemaStore(n) };
          req.onupgradeneeded?.({ target: req, oldVersion, newVersion: version });
        }
        later(() => req.onsuccess?.({ target: req }));
      });
      return req;
    }
  }
  class Database {
    constructor(factory, name, version) { this.factory = factory; this.name = name; this.version = version; this.stores = new Map(); this.pending = []; this.running = false; }
    get objectStoreNames() { return names(this.stores.keys()); }
    _schemaStore(name) {
      const store = this.stores.get(name);
      return { keyPath: store.keyPath, get indexNames() { return names(store.indexes.keys()); },
        createIndex(indexName, keyPath) { store.indexes.set(indexName, keyPath); } };
    }
    createObjectStore(name, { keyPath, autoIncrement = false } = {}) {
      if (this.stores.has(name)) throw new Error('ConstraintError');
      this.stores.set(name, { keyPath, autoIncrement, sequence: 0, indexes: new Map(), data: new Map() });
      return this._schemaStore(name);
    }
    transaction(storeNames, mode = 'readonly') {
      const list = Array.isArray(storeNames) ? storeNames : [storeNames];
      for (const n of list) if (!this.stores.has(n)) throw new Error('NotFoundError: ' + n);
      const tx = new Transaction(this, list, mode); this.pending.push(tx); later(() => this._pump()); return tx;
    }
    _pump() {
      if (this.running || !this.pending.length) return;
      this.running = true;
      const tx = this.pending.shift();
      tx.start(() => { this.running = false; later(() => this._pump()); });
    }
    close() {}
  }
  class Transaction {
    constructor(db, list, mode) { this.db = db; this.list = list; this.mode = mode; this.requests = []; this.aborted = false; this.finished = false; this.error = null; }
    objectStore(name) {
      if (!this.list.includes(name)) throw new Error('NotFoundError');
      return new ObjectStore(this, name);
    }
    enqueue(operation) {
      if (this.finished || this.aborted) throw new Error('TransactionInactiveError');
      const req = {}; this.requests.push({ req, operation }); return req;
    }
    start(done) {
      this.done = done;
      this.working = new Map(this.list.map(n => {
        const s = this.db.stores.get(n);
        return [n, { ...s, indexes: new Map(s.indexes), data: new Map([...s.data].map(([k,v]) => [k,clone(v)])) }];
      }));
      this.step();
    }
    abort() { this.aborted = true; }
    step() {
      if (this.aborted) { this.finished = true; this.onabort?.({target: this}); this.done(); return; }
      const next = this.requests.shift();
      if (!next) {
        if (this.mode === 'readwrite') for (const [n,s] of this.working) this.db.stores.set(n,s);
        this.finished = true; this.oncomplete?.({target:this}); this.done(); return;
      }
      try {
        next.req.result = clone(next.operation(this.working));
        next.req.onsuccess?.({target:next.req});
      } catch (error) {
        this.error = error; next.req.error = error;
        next.req.onerror?.({target:next.req}); this.onerror?.({target:this}); this.aborted = true;
      }
      later(() => this.step());
    }
  }
  class ObjectStore {
    constructor(tx,name) { this.tx=tx; this.name=name; }
    get keyPath() { return this.tx.db.stores.get(this.name).keyPath; }
    get indexNames() { return names(this.tx.db.stores.get(this.name).indexes.keys()); }
    get(key) { return this.tx.enqueue(m => m.get(this.name).data.get(key)); }
    getAll() { return this.tx.enqueue(m => [...m.get(this.name).data.values()]); }
    put(value) { return this.write(value,false); }
    add(value) { return this.write(value,true); }
    write(value,add) {
      if (this.tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
      const v=clone(value), schema=this.tx.db.stores.get(this.name);
      const key = v?.[schema.keyPath];
      if ((key === undefined || key === null) && !schema.autoIncrement) throw new Error('DataError: missing key');
      return this.tx.enqueue(m => {
        if (this.tx.db.factory.failNextPutStore === this.name) {
          this.tx.db.factory.failNextPutStore = null; throw new Error('InjectedQuotaExceededError');
        }
        const s=m.get(this.name); let k=v[s.keyPath];
        if (k === undefined || k === null) v[s.keyPath]=k=++s.sequence;
        else if (typeof k==='number') s.sequence=Math.max(s.sequence,k);
        if (add && s.data.has(k)) throw new Error('ConstraintError');
        s.data.set(k,v); return k;
      });
    }
    clear() { return this.tx.enqueue(m => m.get(this.name).data.clear()); }
    delete(key) { return this.tx.enqueue(m => { m.get(this.name).data.delete(key); }); }
    index(name) {
      const keyPath=this.tx.db.stores.get(this.name).indexes.get(name);
      if (!keyPath) throw new Error('NotFoundError');
      return {
        get: key => this.tx.enqueue(m => [...m.get(this.name).data.values()].find(v => v[keyPath]===key)),
        getAll: key => this.tx.enqueue(m => [...m.get(this.name).data.values()].filter(v => key === undefined || v[keyPath]===key))
      };
    }
  }
  root.CET6MemoryIDB = MemoryIDB;
  if (typeof module !== 'undefined') module.exports = { MemoryIDB };
})(globalThis);
