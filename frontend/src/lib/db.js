// db.js — IndexedDB wrapper for TakeOff Label client-side storage

const DB_NAME    = 'takeoff_label';
const DB_VERSION = 1;

let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const ss = db.createObjectStore('sessions', { keyPath: 'id' });
        ss.createIndex('project_id', 'project_id');
      }
      if (!db.objectStoreNames.contains('marks')) {
        const ms = db.createObjectStore('marks', { keyPath: 'id' });
        ms.createIndex('session_id', 'session_id');
      }
      if (!db.objectStoreNames.contains('annotations')) {
        const as = db.createObjectStore('annotations', { keyPath: 'id' });
        as.createIndex('session_id',   'session_id');
        as.createIndex('mark_id',      'mark_id');
        as.createIndex('session_page', ['session_id', 'page_number']);
      }
      if (!db.objectStoreNames.contains('page_exclusions')) {
        const pe = db.createObjectStore('page_exclusions', { keyPath: 'id' });
        pe.createIndex('session_id', 'session_id');
      }
      if (!db.objectStoreNames.contains('region_exclusions')) {
        const re = db.createObjectStore('region_exclusions', { keyPath: 'id' });
        re.createIndex('session_id', 'session_id');
      }
    };
    req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror    = ()  => reject(req.error);
  });
}

export function txGet(store, key) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  }));
}

export function txGetAll(store) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }));
}

export function txGetAllByIndex(store, indexName, value) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const range = IDBKeyRange.only(value);
    const req = db.transaction(store, 'readonly')
      .objectStore(store).index(indexName).getAll(range);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }));
}

export function txPut(store, record) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(record);
    req.onsuccess = () => resolve(record);
    req.onerror   = () => reject(req.error);
  }));
}

export function txDelete(store, key) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  }));
}

export function txDeleteAllByIndex(store, indexName, value) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx    = db.transaction(store, 'readwrite');
    const range = IDBKeyRange.only(value);
    const req   = tx.objectStore(store).index(indexName).openCursor(range);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  }));
}
