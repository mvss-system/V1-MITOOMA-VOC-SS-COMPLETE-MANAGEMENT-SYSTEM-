;(function (root) {
  'use strict';

  const ENGINE_VERSION = 3;
  const DEFAULT_COLLECTION = 'mvss_individual_record_changes';
  const DEFAULT_PAGE_SIZE = 200;
  const RECEIVER_DB = 'MVSS_Individual_Record_Receiver_v1';
  const RECEIVER_STORE = 'checkpoints';

  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArray = Array.isArray;
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const normalise = value => String(value == null ? '' : value).trim().toLowerCase();
  const stableStringify = value => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  };

  async function sha256(value) {
    const input = typeof value === 'string' ? value : stableStringify(value);
    if (root.crypto && root.crypto.subtle && typeof TextEncoder !== 'undefined') {
      const bytes = new TextEncoder().encode(input);
      const digest = await root.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, '0')).join('');
    }
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'fallback-' + (hash >>> 0).toString(16);
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function makeOperationId() {
    const random = root.crypto && root.crypto.randomUUID
      ? root.crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    return 'mvss-op-' + random;
  }

  function getPathValue(object, path) {
    return path.split('.').reduce((value, key) => value == null ? undefined : value[key], object);
  }

  function setPathValue(object, path, value) {
    const parts = path.split('.');
    let target = object;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isObject(target[parts[i]])) target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = value;
  }

  function removePathValue(object, path) {
    const parts = path.split('.');
    let target = object;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isObject(target[parts[i]])) return;
      target = target[parts[i]];
    }
    delete target[parts[parts.length - 1]];
  }

  function getRecordIdentity(section, record) {
    if (!record || typeof record !== 'object') return null;
    const id = record.id ?? record.studentId ?? record.studentID ?? record.phone ?? record.key;
    if (id == null || String(id).trim() === '') return null;

    if (section === 'marks') {
      return [
        normalise(id),
        normalise(record.term || record.termName),
        normalise(record.subject || record.subjectName)
      ].join('|');
    }

    if (section === 'caiResults') {
      return [
        normalise(record.studentId || record.studentID || id),
        normalise(record.term || record.termName),
        normalise(record.subject || record.subjectName)
      ].join('|');
    }

    if (section === 'teachers') return normalise(record.phone || id);
    return normalise(id);
  }

  function getMapIdentity(section, key) {
    return normalise(key);
  }

  function flattenDatabase(database) {
    assert(isObject(database), 'Database must be an object.');
    const records = new Map();

    for (const section of Object.keys(database)) {
      const value = database[section];

      if (isArray(value)) {
        const seen = new Set();
        for (const record of value) {
          const identity = getRecordIdentity(section, record);
          assert(identity, 'Record in section "' + section + '" has no stable identity.');
          assert(!seen.has(identity), 'Duplicate record identity in section "' + section + '": ' + identity);
          seen.add(identity);
          records.set(section + '|' + identity, {
            section,
            kind: 'array',
            identity,
            value: clone(record)
          });
        }
      } else if (isObject(value)) {
        for (const mapKey of Object.keys(value)) {
          const identity = getMapIdentity(section, mapKey);
          records.set(section + '|' + identity, {
            section,
            kind: 'map',
            identity,
            mapKey,
            value: clone(value[mapKey])
          });
        }
      } else {
        records.set(section + '|__singleton__', {
          section,
          kind: 'singleton',
          identity: '__singleton__',
          value: clone(value)
        });
      }
    }

    return records;
  }

  async function fingerprint(value) {
    return sha256(stableStringify(value));
  }

  async function diffDatabases(baseDatabase, nextDatabase, options = {}) {
    const before = flattenDatabase(baseDatabase);
    const after = flattenDatabase(nextDatabase);
    const operations = [];
    const now = Date.now();

    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const oldRecord = before.get(key);
      const newRecord = after.get(key);
      if (oldRecord && newRecord && stableStringify(oldRecord.value) === stableStringify(newRecord.value)) continue;

      const reference = newRecord || oldRecord;
      const operation = {
        operationId: makeOperationId(),
        engineVersion: ENGINE_VERSION,
        section: reference.section,
        kind: reference.kind,
        identity: reference.identity,
        mapKey: reference.mapKey || null,
        operation: newRecord ? 'upsert' : 'delete',
        value: newRecord ? clone(newRecord.value) : null,
        changedAtMs: now,
        changedAt: new Date(now).toISOString(),
        baseHash: oldRecord ? await fingerprint(oldRecord.value) : null,
        recordHash: newRecord ? await fingerprint(newRecord.value) : null,
        actor: options.actor || 'unknown',
        source: options.source || 'app'
      };

      operations.push(operation);
    }

    return operations;
  }

  function validateDatabase(database) {
    assert(isObject(database), 'Database must be an object.');
    const flattened = flattenDatabase(database);
    return {
      valid: true,
      sections: Object.keys(database).length,
      records: flattened.size
    };
  }

  function getRecord(database, event) {
    const section = event.section;
    const value = database[section];

    if (event.kind === 'array') {
      if (!isArray(value)) return null;
      return value.find(record => getRecordIdentity(section, record) === event.identity) || null;
    }

    if (event.kind === 'map') {
      if (!isObject(value)) return null;
      return value[event.mapKey];
    }

    return database[section];
  }

  function applyEvent(database, event) {
    const next = clone(database);
    const section = event.section;

    if (event.kind === 'array') {
      if (!isArray(next[section])) next[section] = [];
      const index = next[section].findIndex(record => getRecordIdentity(section, record) === event.identity);

      if (event.operation === 'delete') {
        if (index >= 0) next[section].splice(index, 1);
      } else {
        assert(event.value && typeof event.value === 'object', 'Incoming array record is invalid.');
        if (index >= 0) next[section][index] = clone(event.value);
        else next[section].push(clone(event.value));
      }
    } else if (event.kind === 'map') {
      if (!isObject(next[section])) next[section] = {};
      if (event.operation === 'delete') delete next[section][event.mapKey];
      else next[section][event.mapKey] = clone(event.value);
    } else if (event.kind === 'singleton') {
      next[section] = event.operation === 'delete' ? null : clone(event.value);
    } else {
      throw new Error('Unsupported incoming record kind: ' + event.kind);
    }

    return next;
  }

  function validateEvent(event) {
    assert(isObject(event), 'Incoming event must be an object.');
    assert(event.engineVersion >= 3, 'Incoming event uses an unsupported older format.');
    assert(typeof event.operationId === 'string' && event.operationId, 'Incoming event has no operation ID.');
    assert(typeof event.section === 'string' && event.section, 'Incoming event has no section.');
    assert(['array', 'map', 'singleton'].includes(event.kind), 'Incoming event has an invalid record kind.');
    assert(['upsert', 'delete'].includes(event.operation), 'Incoming event has an invalid operation.');
    assert(Number.isFinite(Number(event.changedAtMs)), 'Incoming event has no valid change timestamp.');
    assert(typeof event.baseHash === 'string' || event.baseHash === null, 'Incoming event has no valid base hash.');
    if (event.operation === 'upsert') assert(event.value !== undefined, 'Incoming upsert has no record value.');
    if (event.kind === 'map') assert(typeof event.mapKey === 'string' && event.mapKey, 'Incoming map event has no map key.');
    return true;
  }

  function openReceiverStore() {
    return new Promise((resolve, reject) => {
      assert(root.indexedDB, 'IndexedDB is unavailable in this browser.');
      const req = root.indexedDB.open(RECEIVER_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(RECEIVER_STORE)) {
          db.createObjectStore(RECEIVER_STORE, { keyPath: 'namespace' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('Could not open incoming-record checkpoint store.'));
      req.onblocked = () => reject(new Error('Close other MVSS tabs before opening incoming-record checkpoints.'));
    });
  }

  async function getReceiverCheckpoint(namespace) {
    const db = await openReceiverStore();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RECEIVER_STORE, 'readonly');
      const req = tx.objectStore(RECEIVER_STORE).get(namespace);
      req.onsuccess = () => {
        const value = req.result || {
          namespace,
          lastChangedAtMs: 0,
          lastOperationId: ''
        };
        db.close();
        resolve(value);
      };
      req.onerror = () => {
        const error = req.error;
        db.close();
        reject(error || new Error('Could not read incoming-record checkpoint.'));
      };
    });
  }

  async function putReceiverCheckpoint(value) {
    const db = await openReceiverStore();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RECEIVER_STORE, 'readwrite');
      tx.objectStore(RECEIVER_STORE).put(value);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        const error = tx.error;
        db.close();
        reject(error || new Error('Could not save incoming-record checkpoint.'));
      };
      tx.onabort = () => {
        const error = tx.error;
        db.close();
        reject(error || new Error('Incoming-record checkpoint transaction was aborted.'));
      };
    });
  }

  function compareEvents(a, b) {
    const timeDifference = Number(a.changedAtMs) - Number(b.changedAtMs);
    if (timeDifference !== 0) return timeDifference;
    return String(a.operationId).localeCompare(String(b.operationId));
  }

  function makeReceiver(options = {}) {
    const firestore = options.firestore || root.firebase?.firestore?.();
    assert(firestore, 'Firebase Firestore is not available.');
    const collectionName = options.collection || DEFAULT_COLLECTION;
    const namespace = options.namespace || 'mvss-default';
    const pageSize = Math.max(1, Math.min(500, Number(options.pageSize) || DEFAULT_PAGE_SIZE));
    const collection = firestore.collection(collectionName);
    let receiving = false;
    let stopped = false;
    let timer = null;

    async function readPendingLocalIdentity(event) {
      if (typeof options.hasPendingLocalEdit !== 'function') return false;
      return Boolean(await options.hasPendingLocalEdit(event));
    }

    async function receiveChanges(getDatabase, commitDatabase, receiveOptions = {}) {
      assert(typeof getDatabase === 'function', 'Receiver requires getDatabase().');
      assert(typeof commitDatabase === 'function', 'Receiver requires commitDatabase().');
      if (receiving) return { received: 0, skipped: true, reason: 'already-receiving' };
      receiving = true;

      let received = 0;
      let checkpoint = await getReceiverCheckpoint(namespace);

      try {
        const query = collection
          .orderBy('changedAtMs', 'asc')
          .orderBy('operationId', 'asc')
          .limit(pageSize);

        let cursor = null;
        let hasMore = true;

        while (hasMore && !stopped) {
          let pageQuery = query;

          if (cursor) pageQuery = pageQuery.startAfter(cursor);
          else if (checkpoint.lastOperationId) {
            pageQuery = pageQuery.startAfter(
              checkpoint.lastChangedAtMs,
              checkpoint.lastOperationId
            );
          }

          const snapshot = await pageQuery.get();
          if (snapshot.empty) break;

          const events = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          events.sort(compareEvents);

          for (const event of events) {
            validateEvent(event);

            const isAfterCheckpoint =
              Number(event.changedAtMs) > Number(checkpoint.lastChangedAtMs) ||
              (
                Number(event.changedAtMs) === Number(checkpoint.lastChangedAtMs) &&
                String(event.operationId) > String(checkpoint.lastOperationId)
              );

            if (!isAfterCheckpoint) continue;

            if (await readPendingLocalIdentity(event)) {
              return {
                received,
                paused: true,
                reason: 'pending-local-edit',
                event
              };
            }

            const currentDatabase = await getDatabase();
            assert(isObject(currentDatabase), 'Local database could not be read.');

            const localRecord = getRecord(currentDatabase, event);
            const localHash = localRecord == null ? null : await fingerprint(localRecord);

            if (localHash !== event.baseHash) {
              return {
                received,
                paused: true,
                reason: 'record-conflict',
                event,
                localHash,
                expectedBaseHash: event.baseHash
              };
            }

            const nextDatabase = applyEvent(currentDatabase, event);
            await commitDatabase(nextDatabase, event);

            checkpoint = {
              namespace,
              lastChangedAtMs: Number(event.changedAtMs),
              lastOperationId: String(event.operationId),
              updatedAt: new Date().toISOString()
            };

            await putReceiverCheckpoint(checkpoint);
            received++;
          }

          cursor = snapshot.docs[snapshot.docs.length - 1];
          hasMore = snapshot.size === pageSize;
        }

        return { received, paused: false, checkpoint };
      } finally {
        receiving = false;
      }
    }

    function startReceiver(getDatabase, commitDatabase, startOptions = {}) {
      if (timer) return;
      stopped = false;
      const interval = Math.max(5000, Number(startOptions.intervalMs) || 15000);

      const tick = async () => {
        if (stopped || receiving) return;
        try {
          const result = await receiveChanges(getDatabase, commitDatabase, startOptions);
          if (typeof startOptions.onResult === 'function') startOptions.onResult(result);
        } catch (error) {
          if (typeof startOptions.onError === 'function') startOptions.onError(error);
        }
      };

      tick();
      timer = root.setInterval(tick, interval);

      if (root.addEventListener) {
        root.addEventListener('online', tick);
      }

      return {
        stop() {
          stopped = true;
          if (timer) root.clearInterval(timer);
          timer = null;
          if (root.removeEventListener) root.removeEventListener('online', tick);
        }
      };
    }

    return {
      receiveChanges,
      startReceiver,
      getCheckpoint: () => getReceiverCheckpoint(namespace)
    };
  }

  function createPublisher(options = {}) {
    const firestore = options.firestore || root.firebase?.firestore?.();
    assert(firestore, 'Firebase Firestore is not available.');
    const collectionName = options.collection || DEFAULT_COLLECTION;
    const collection = firestore.collection(collectionName);
    const actor = options.actor || 'unknown';

    async function publishOperations(operations) {
      assert(Array.isArray(operations), 'Operations must be an array.');
      if (!operations.length) return { published: 0 };

      const batchLimit = 400;
      let published = 0;

      for (let offset = 0; offset < operations.length; offset += batchLimit) {
        const batch = firestore.batch();
        const part = operations.slice(offset, offset + batchLimit);

        for (const operation of part) {
          validateEvent(operation);
          const document = collection.doc(operation.operationId);
          batch.set(document, {
            ...operation,
            actor,
            publishedAt: root.firebase.firestore.FieldValue.serverTimestamp()
          });
        }

        await batch.commit();
        published += part.length;
      }

      return { published };
    }

    return { publishOperations };
  }

  const api = {
    ENGINE_VERSION,
    DEFAULT_COLLECTION,
    flattenDatabase,
    diffDatabases,
    validateDatabase,
    validateEvent,
    applyEvent,
    fingerprint,
    createPublisher,
    makeReceiver,
    getRecordIdentity
  };

  root.MVSSIndividualRecordSync = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
