
/*
 * MVSS individual-record sync migration core — preparation build.
 * Safe/local-only: validates identities, flattens the database into stable
 * record documents, and calculates per-record changes. It does NOT connect to
 * Firestore or alter the live database. Integration is a separate step.
 */
(function (root) {
  'use strict';

  const ARRAY_MODULES = [
    'students', 'teachers', 'libraryLoans', 'marks', 'fees', 'attendance',
    'uploadedLetters', 'payroll', 'announcements', 'caiResults',
    'parentComplaints', 'staffLeaveRequests', 'financialAdjustments',
    'deletedRecordTombstones', 'securityAuditLog', 'directMessages',
    'subjectTeacherInitials'
  ];
  const MAP_MODULES = [
    'classAttendance', 'categoryFees', 'termSettings', 'securitySettings',
    'adminAccounts', 'classAttendanceSessions'
  ];
  const SINGLETON_MODULES = ['marksSubmissionDays'];
  const SCHEMA_VERSION = 2;
  const KNOWN_MODULES = new Set([...ARRAY_MODULES, ...MAP_MODULES, ...SINGLETON_MODULES]);

  function norm(v) {
    return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }
  function stableJson(value) {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  }
  function hash32(text, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(36);
  }
  function fingerprint(value) {
    const s = stableJson(value);
    return hash32(s, 2166136261) + hash32(s, 2246822519);
  }
  function requiredParts(record, fields) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const values = fields.map(k => record[k]);
    if (values.some(v => v === undefined || v === null || String(v).trim() === '')) return null;
    return values.map(norm);
  }
  function naturalKey(moduleName, record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    let parts;
    if (moduleName === 'subjectTeacherInitials') {
      parts = requiredParts(record, ['className', 'subject', 'term']);
      return parts && 'sti|' + parts.join('|');
    }
    if (moduleName === 'marks') {
      parts = requiredParts(record, ['id', 'term', 'subject']);
      return parts && 'mark|' + parts.concat(norm(record.assessmentType || '')).join('|');
    }
    if (moduleName === 'caiResults') {
      parts = requiredParts(record, ['studentId', 'className', 'term', 'subject']);
      return parts && 'cai|' + parts.join('|');
    }
    if (moduleName === 'teachers') {
      parts = requiredParts(record, ['phone']);
      return parts && 'phone|' + String(record.phone).replace(/[\s()+-]/g, '');
    }
    parts = requiredParts(record, ['id']);
    return parts && 'id|' + parts[0];
  }
  function firestoreId(moduleName, natural) {
    const full = moduleName + '|' + natural;
    return 'r_' + hash32(full, 2166136261) + hash32(full, 2246822519);
  }
  function validateArray(moduleName, records) {
    if (!Array.isArray(records)) return { ok: false, module: moduleName, errors: ['Expected an array.'] };
    const seenKeys = new Map(), seenIds = new Map(), errors = [];
    records.forEach((record, index) => {
      const key = naturalKey(moduleName, record);
      if (!key) { errors.push('Row ' + (index + 1) + ' has no stable identity.'); return; }
      const docId = firestoreId(moduleName, key);
      if (seenKeys.has(key)) errors.push('Duplicate identity at rows ' + (seenKeys.get(key) + 1) + ' and ' + (index + 1) + ': ' + key);
      else seenKeys.set(key, index);
      if (seenIds.has(docId) && seenIds.get(docId).key !== key) errors.push('Firestore document-ID hash collision between rows ' + (seenIds.get(docId).index + 1) + ' and ' + (index + 1) + '.');
      else seenIds.set(docId, { key, index });
    });
    return { ok: errors.length === 0, module: moduleName, count: records.length, errors };
  }
  function validateDatabase(database) {
    const report = { schemaVersion: SCHEMA_VERSION, ok: true, modules: [], unknownTopLevelKeys: [] };
    if (!database || typeof database !== 'object' || Array.isArray(database))
      return { schemaVersion: SCHEMA_VERSION, ok: false, modules: [], errors: ['Database must be an object.'] };
    ARRAY_MODULES.forEach(name => {
      if (database[name] !== undefined) {
        const result = validateArray(name, database[name]); report.modules.push(result);
        if (!result.ok) report.ok = false;
      }
    });
    MAP_MODULES.forEach(name => {
      if (database[name] !== undefined) {
        const value = database[name], valid = !!value && typeof value === 'object' && !Array.isArray(value);
        report.modules.push({ module: name, kind: 'keyed-map', count: valid ? Object.keys(value).length : 0, ok: valid, errors: valid ? [] : ['Expected a keyed object/map.'] });
        if (!valid) report.ok = false;
      }
    });
    SINGLETON_MODULES.forEach(name => {
      if (database[name] !== undefined) report.modules.push({ module: name, kind: 'singleton', count: 1, ok: true, errors: [] });
    });
    report.unknownTopLevelKeys = Object.keys(database).filter(k => !KNOWN_MODULES.has(k));
    if (report.unknownTopLevelKeys.length) report.ok = false;
    return report;
  }
  function flattenDatabase(database) {
    const validation = validateDatabase(database);
    if (!validation.ok) {
      const reasons = validation.modules.filter(m => !m.ok).map(m => m.module + ': ' + m.errors.join('; '));
      if (validation.unknownTopLevelKeys.length) reasons.push('Unknown top-level sections: ' + validation.unknownTopLevelKeys.join(', '));
      throw new Error('Database validation failed; no records were flattened. ' + reasons.join(' | '));
    }
    const docs = [], seenDocIds = new Map();
    ARRAY_MODULES.forEach(moduleName => (database[moduleName] || []).forEach(record => {
      const key = naturalKey(moduleName, record), id = firestoreId(moduleName, key);
      if (seenDocIds.has(id) && seenDocIds.get(id) !== moduleName + '|' + key) throw new Error('Firestore document-ID collision at ' + id);
      seenDocIds.set(id, moduleName + '|' + key);
      docs.push({ documentId: id, module: moduleName, recordKey: key, kind: 'record', value: record, valueHash: fingerprint(record), schemaVersion: SCHEMA_VERSION });
    }));
    MAP_MODULES.forEach(moduleName => Object.keys(database[moduleName] || {}).forEach(mapKey => {
      const key = 'map|' + mapKey, id = firestoreId(moduleName, key), value = database[moduleName][mapKey];
      if (seenDocIds.has(id) && seenDocIds.get(id) !== moduleName + '|' + key) throw new Error('Firestore document-ID collision at ' + id);
      seenDocIds.set(id, moduleName + '|' + key);
      docs.push({ documentId: id, module: moduleName, recordKey: key, mapKey, kind: 'map-entry', value, valueHash: fingerprint(value), schemaVersion: SCHEMA_VERSION });
    }));
    SINGLETON_MODULES.forEach(moduleName => {
      if (database[moduleName] !== undefined) {
        const key = 'singleton|' + moduleName, id = firestoreId(moduleName, key), value = database[moduleName];
        docs.push({ documentId: id, module: moduleName, recordKey: key, kind: 'singleton', value, valueHash: fingerprint(value), schemaVersion: SCHEMA_VERSION });
      }
    });
    return docs;
  }
  function diffDatabases(beforeDatabase, afterDatabase) {
    const before = new Map(flattenDatabase(beforeDatabase).map(x => [x.module + '|' + x.recordKey, x]));
    const after = new Map(flattenDatabase(afterDatabase).map(x => [x.module + '|' + x.recordKey, x]));
    const changes = [];
    for (const [identity, oldDoc] of before) {
      if (!after.has(identity)) changes.push({ operation: 'delete', module: oldDoc.module, recordKey: oldDoc.recordKey, documentId: oldDoc.documentId, baseHash: oldDoc.valueHash });
    }
    for (const [identity, newDoc] of after) {
      const oldDoc = before.get(identity);
      if (!oldDoc || oldDoc.valueHash !== newDoc.valueHash)
        changes.push({ operation: 'upsert', module: newDoc.module, recordKey: newDoc.recordKey, documentId: newDoc.documentId, baseHash: oldDoc ? oldDoc.valueHash : null, valueHash: newDoc.valueHash, kind: newDoc.kind, value: newDoc.value, mapKey: newDoc.mapKey });
    }
    return changes;
  }
  function makeOperationId(change, revision, changedAt) {
    return 'op_' + hash32([change.module, change.recordKey, change.operation, revision, changedAt, change.valueHash || ''].join('|'), 2166136261) + hash32([change.documentId, changedAt].join('|'), 2246822519);
  }
  function buildOperations(beforeDatabase, afterDatabase, revision, changedAt) {
    const at = changedAt || new Date().toISOString();
    return diffDatabases(beforeDatabase, afterDatabase).map(change => ({
      ...change,
      operationId: makeOperationId(change, revision, at),
      schemaVersion: SCHEMA_VERSION,
      revision: Number(revision) || 0,
      changedAt: at
    }));
  }

  root.MVSSRecordSyncPrep = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    arrayModules: ARRAY_MODULES.slice(),
    mapModules: MAP_MODULES.slice(),
    singletonModules: SINGLETON_MODULES.slice(),
    naturalKey, firestoreId, fingerprint, validateArray, validateDatabase,
    flattenDatabase, diffDatabases, buildOperations
  });
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * MVSS INDIVIDUAL-RECORD SYNC ENGINE — integration component
 * Requires MVSSRecordSyncPrep (bundled above) and Firebase Firestore compat SDK.
 * This engine is intentionally NOT auto-started and does not replace the legacy
 * whole-database publisher until the host app explicitly integrates and tests it.
 */
(function(root){
  'use strict';
  const Prep = root.MVSSRecordSyncPrep;
  const ENGINE_VERSION = 1;
  const DB_NAME = 'MVSS_Individual_Record_Queue_v1';
  const STORE = 'operations';
  const DEFAULT_BATCH = 300;

  function assert(condition, message){ if(!condition) throw new Error(message); }
  function openQueue(){
    return new Promise((resolve,reject)=>{
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{keyPath:'operationId'});
      };
      req.onsuccess = () => { const db=req.result; db.onversionchange=()=>db.close(); resolve(db); };
      req.onerror = () => reject(req.error || new Error('Could not open individual-record offline queue.'));
      req.onblocked = () => reject(new Error('Close other MVSS tabs before opening the individual-record queue.'));
    });
  }
  async function queuePutMany(items){
    const db=await openQueue();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite'), store=tx.objectStore(STORE);
      items.forEach(item=>store.put(item));
      tx.oncomplete=()=>{db.close();resolve(items.length);};
      tx.onerror=()=>{const e=tx.error;db.close();reject(e||new Error('Could not save offline record operations.'));};
      tx.onabort=()=>{const e=tx.error;db.close();reject(e||new Error('Offline record queue transaction was aborted.'));};
    });
  }
  async function queueAll(){
    const db=await openQueue();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readonly'), req=tx.objectStore(STORE).getAll();
      req.onsuccess=()=>{const out=req.result||[];db.close();resolve(out.sort((a,b)=>(a.createdAtMs||0)-(b.createdAtMs||0)));};
      req.onerror=()=>{const e=req.error;db.close();reject(e||new Error('Could not read offline record queue.'));};
    });
  }
  async function queueDelete(operationId){
    const db=await openQueue();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).delete(operationId);
      tx.oncomplete=()=>{db.close();resolve();};
      tx.onerror=()=>{const e=tx.error;db.close();reject(e||new Error('Could not acknowledge synced record operation.'));};
    });
  }

  function create(options){
    assert(Prep,'MVSSRecordSyncPrep is missing. Load the bundled preparation module first.');
    options=options||{};
    const firestore=options.firestore;
    assert(firestore && typeof firestore.collection==='function','Pass the initialized Firebase Firestore compat instance as firestore.');
    const schoolCollection=String(options.schoolCollection||'mitooma_school');
    const namespace=String(options.namespace||'individual_record_store_v1');
    const recordsRef=firestore.collection(schoolCollection).doc(namespace).collection('records');
    const eventsRef=firestore.collection(schoolCollection).doc(namespace).collection('events');
    const controlRef=firestore.collection(schoolCollection).doc(namespace);
    const writerId=String(options.writerId||('device-'+Math.random().toString(36).slice(2,12)));
    let flushing=Promise.resolve();

    async function inspect(database){
      const validation=Prep.validateDatabase(database);
      if(!validation.ok) throw new Error('Record migration blocked: '+validation.modules.filter(x=>!x.ok).map(x=>x.module+': '+(x.errors||[]).join('; ')).join(' | ')+(validation.unknownTopLevelKeys.length?'; Unknown sections: '+validation.unknownTopLevelKeys.join(', '):''));
      const documents=Prep.flattenDatabase(database);
      return {schemaVersion:Prep.schemaVersion,valid:true,documentCount:documents.length,modules:validation.modules,documents};
    }

    // One-time, restartable import into a NEW Firestore namespace. Existing main_db
    // is never overwritten. Re-running uses deterministic document IDs and is safe.
    async function migrate(database, progress){
      const report=await inspect(database);
      const docs=report.documents;
      const existingControl=await controlRef.get();
      const existingSync=(existingControl.exists && (existingControl.data()||{}).individualRecordSync)||null;
      if(existingSync && existingSync.migrationStatus==='complete') throw new Error('Migration is already marked complete. Refusing to overwrite individual records. Use an explicit recovery procedure if a restart is required.');
      const batchSize=Math.max(1,Math.min(400,Number(options.migrationBatchSize)||DEFAULT_BATCH));
      for(let offset=0;offset<docs.length;offset+=batchSize){
        const batch=firestore.batch();
        docs.slice(offset,offset+batchSize).forEach(doc=>{
          batch.set(recordsRef.doc(doc.documentId),{
            module:doc.module,recordKey:doc.recordKey,kind:doc.kind,
            value:doc.value,mapKey:doc.mapKey||null,valueHash:doc.valueHash,
            schemaVersion:doc.schemaVersion,deleted:false,
            migratedAtMs:Date.now(),lastOperationId:'migration:'+doc.documentId
          },{merge:false});
        });
        await batch.commit();
        if(typeof progress==='function') progress({completed:Math.min(offset+batchSize,docs.length),total:docs.length,phase:'upload'});
      }
      await controlRef.set({
        individualRecordSync:{engineVersion:ENGINE_VERSION,schemaVersion:Prep.schemaVersion,
          migrationStatus:'complete',recordCount:docs.length,completedAtMs:Date.now(),
          namespace,source:'MVSS local database snapshot'},
      },{merge:true});
      return {ok:true,recordCount:docs.length,modules:report.modules.map(m=>({module:m.module,count:m.count,kind:m.kind||'array'})),namespace};
    }

    async function enqueueChanges(beforeDatabase,afterDatabase,revision){
      const operations=Prep.buildOperations(beforeDatabase,afterDatabase,revision, new Date().toISOString());
      const now=Date.now();
      const queued=operations.map(op=>({...op,writerId,createdAtMs:now,attempts:0}));
      if(queued.length) await queuePutMany(queued);
      return {queued:queued.length,operations:queued};
    }

    async function applyOperation(op){
      const ref=recordsRef.doc(op.documentId);
      const eventRef=eventsRef.doc(op.operationId);
      await firestore.runTransaction(async tx=>{
        const snap=await tx.get(ref);
        const current=snap.exists?(snap.data()||{}):null;
        if(current && current.lastOperationId===op.operationId) return;
        const currentHash=current ? (current.deleted ? '__MVSS_TOMBSTONE__' : current.valueHash) : null;
        if(currentHash!==op.baseHash){
          const error=new Error('RECORD_CONFLICT: '+op.module+' '+op.recordKey+' changed on another device. Local operation remains queued.');
          error.code='MVSS_RECORD_CONFLICT'; throw error;
        }
        const now=Date.now();
        const body={module:op.module,recordKey:op.recordKey,kind:op.kind|| (current&&current.kind)||'record',
          value:op.operation==='delete'?null:op.value,mapKey:op.mapKey||null,
          valueHash:op.operation==='delete'?null:op.valueHash,
          deleted:op.operation==='delete',schemaVersion:op.schemaVersion,
          revision:op.revision,writerId:op.writerId,updatedAtMs:now,lastOperationId:op.operationId};
        tx.set(ref,body);
        tx.set(eventRef,{operationId:op.operationId,documentId:op.documentId,module:op.module,
          recordKey:op.recordKey,operation:op.operation,value:body.value,valueHash:body.valueHash,
          deleted:body.deleted,schemaVersion:op.schemaVersion,writerId:op.writerId,
          changedAtMs:now});
      });
    }

    async function flush(){
      flushing=flushing.then(async()=>{
        const pending=await queueAll();
        const results={sent:0,remaining:pending.length,conflicts:[],errors:[]};
        for(const op of pending){
          try{await applyOperation(op);await queueDelete(op.operationId);results.sent++;}
          catch(error){
            if(error && error.code==='MVSS_RECORD_CONFLICT') results.conflicts.push({operationId:op.operationId,module:op.module,recordKey:op.recordKey,message:error.message});
            else results.errors.push({operationId:op.operationId,message:String(error&&error.message||error)});
            // Preserve this operation and later operations; never discard unsynced work.
            break;
          }
        }
        results.remaining=(await queueAll()).length;
        return results;
      });
      return flushing;
    }

    async function pendingCount(){return (await queueAll()).length;}

    // Subscribe to the append-only change feed. Caller must persist lastSeenMs and
    // apply each event through the app's record-aware merge before advancing it.
    function listenSince(lastSeenMs,onEvent,onError){
      assert(typeof onEvent==='function','listenSince requires an onEvent callback.');
      let query=eventsRef.where('changedAtMs','>',Number(lastSeenMs)||0).orderBy('changedAtMs','asc').limit(500);
      return query.onSnapshot(snapshot=>{
        snapshot.docChanges().forEach(change=>{
          if(change.type!=='removed') onEvent(change.doc.data(),change.doc.id);
        });
      },error=>{if(typeof onError==='function')onError(error);});
    }

    async function readRecord(moduleName,recordKey){
      const id=Prep.firestoreId(moduleName,recordKey);
      const snap=await recordsRef.doc(id).get();
      if(!snap.exists)return null;
      const value=snap.data()||{};
      if(value.module!==moduleName||value.recordKey!==recordKey) throw new Error('Record identity check failed; refusing to use this document.');
      return value;
    }

    return Object.freeze({inspect,migrate,enqueueChanges,flush,pendingCount,listenSince,readRecord,
      namespace,schemaVersion:Prep.schemaVersion,engineVersion:ENGINE_VERSION});
  }

  root.MVSSIndividualRecordSync = Object.freeze({create,engineVersion:ENGINE_VERSION,schemaVersion:Prep?Prep.schemaVersion:null});
})(typeof window!=='undefined'?window:globalThis);
