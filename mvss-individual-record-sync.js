/*
 * MVSS individual-record sync preparation core — schema-compatible audit build.
 * It validates and flattens the current MVSS database without changing it.
 * This file does NOT start sync or replace the existing whole-database sync.
 */
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 3;
  const ARRAY_MODULES = [
    'students','teachers','libraryLoans','marks','fees','attendance','uploadedLetters',
    'payroll','announcements','parentComplaints','staffLeaveRequests','financialAdjustments',
    'deletedRecordTombstones','caiResults','securityAuditLog','directMessages','subjectTeacherInitials'
  ];
  const MAP_MODULES = ['classAttendance','categoryFees','termSettings','securitySettings','adminAccounts','classAttendanceSessions'];
  const SINGLETON_MODULES = ['marksSubmissionDays','termStartDate'];

  function norm(v) { return String(v == null ? '' : v).trim().replace(/\s+/g,' ').toLocaleLowerCase(); }
  function stableJson(value) {
    if (value === undefined) return '"__MVSS_UNDEFINED__"';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  }
  function hash32(text, seed) {
    let h = seed >>> 0;
    for (let i=0;i<text.length;i++) { h ^= text.charCodeAt(i); h = Math.imul(h,16777619) >>> 0; }
    return h.toString(36);
  }
  function fingerprint(value) {
    const s=stableJson(value);
    return hash32(s,2166136261)+hash32(s,2246822519);
  }
  function requiredParts(record, fields) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const values=fields.map(k=>record[k]);
    if (values.some(v=>v===undefined || v===null || String(v).trim()==='')) return null;
    return values.map(norm);
  }
  function naturalKey(moduleName, record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    let parts;
    if (moduleName==='subjectTeacherInitials') {
      parts=requiredParts(record,['className','subject','term']);
      return parts && 'sti|'+parts.join('|');
    }
    if (moduleName==='marks') {
      parts=requiredParts(record,['id','term','subject']);
      if (!parts) return null;
      return 'mark|'+parts.join('|')+'|'+norm(record.assessmentType || '');
    }
    if (moduleName==='caiResults') {
      parts=requiredParts(record,['studentId','term','subject']);
      return parts && 'cai|'+parts.join('|');
    }
    if (moduleName==='teachers') {
      parts=requiredParts(record,['phone']);
      return parts && 'phone|'+String(record.phone).replace(/[\s()+-]/g,'');
    }
    parts=requiredParts(record,['id']);
    return parts && 'id|'+parts[0];
  }
  function firestoreId(moduleName,natural) {
    const full=moduleName+'|'+natural;
    return 'r_'+hash32(full,2166136261)+hash32(full,2246822519);
  }
  function classify(value) {
    if (Array.isArray(value)) return 'array';
    if (value && typeof value==='object') return 'map';
    return 'singleton';
  }
  function validateArray(moduleName,records) {
    if (!Array.isArray(records)) return {ok:false,module:moduleName,errors:['Expected an array.']};
    const seenKeys=new Map(),seenIds=new Map(),errors=[];
    records.forEach((record,index)=>{
      const key=naturalKey(moduleName,record);
      if (!key) { errors.push('Row '+(index+1)+' has no stable identity.'); return; }
      const docId=firestoreId(moduleName,key);
      if (seenKeys.has(key)) errors.push('Duplicate identity at rows '+(seenKeys.get(key)+1)+' and '+(index+1)+': '+key);
      else seenKeys.set(key,index);
      if (seenIds.has(docId) && seenIds.get(docId).key!==key) errors.push('Firestore document-ID hash collision between rows '+(seenIds.get(docId).index+1)+' and '+(index+1)+'.');
      else seenIds.set(docId,{key,index});
    });
    return {ok:errors.length===0,module:moduleName,count:records.length,errors};
  }
  function validateDatabase(database) {
    const report={schemaVersion:SCHEMA_VERSION,ok:true,modules:[],unknownTopLevelKeys:[]};
    if (!database || typeof database!=='object' || Array.isArray(database))
      return {schemaVersion:SCHEMA_VERSION,ok:false,modules:[],errors:['Database must be an object.']};
    Object.keys(database).sort().forEach(name=>{
      const kind=classify(database[name]);
      if (kind==='array') {
        const result=validateArray(name,database[name]); report.modules.push(result);
        if (!result.ok) report.ok=false;
      } else if (kind==='map') {
        report.modules.push({module:name,kind:'keyed-map',count:Object.keys(database[name]).length,ok:true,errors:[]});
      } else {
        report.modules.push({module:name,kind:'singleton',count:1,ok:true,errors:[]});
      }
    });
    report.unknownTopLevelKeys=Object.keys(database).filter(k=>!ARRAY_MODULES.includes(k)&&!MAP_MODULES.includes(k)&&!SINGLETON_MODULES.includes(k));
    return report;
  }
  function flattenDatabase(database) {
    const validation=validateDatabase(database);
    if (!validation.ok) {
      const reasons=validation.modules.filter(m=>!m.ok).map(m=>m.module+': '+m.errors.join('; '));
      throw new Error('Database validation failed; no records were flattened. '+reasons.join(' | '));
    }
    const docs=[],seenDocIds=new Map();
    function add(doc) {
      const identity=doc.module+'|'+doc.recordKey;
      if (seenDocIds.has(doc.documentId) && seenDocIds.get(doc.documentId)!==identity)
        throw new Error('Firestore document-ID collision at '+doc.documentId);
      seenDocIds.set(doc.documentId,identity); docs.push(doc);
    }
    Object.keys(database).sort().forEach(moduleName=>{
      const value=database[moduleName],kind=classify(value);
      if (kind==='array') {
        value.forEach(record=>{
          const key=naturalKey(moduleName,record);
          add({documentId:firestoreId(moduleName,key),module:moduleName,recordKey:key,kind:'record',value:record,valueHash:fingerprint(record),schemaVersion:SCHEMA_VERSION});
        });
      } else if (kind==='map') {
        Object.keys(value).sort().forEach(mapKey=>{
          const key='map|'+mapKey,entry=value[mapKey];
          add({documentId:firestoreId(moduleName,key),module:moduleName,recordKey:key,mapKey,kind:'map-entry',value:entry,valueHash:fingerprint(entry),schemaVersion:SCHEMA_VERSION});
        });
      } else {
        const key='singleton|'+moduleName;
        add({documentId:firestoreId(moduleName,key),module:moduleName,recordKey:key,kind:'singleton',value,valueHash:fingerprint(value),schemaVersion:SCHEMA_VERSION});
      }
    });
    return docs;
  }
  function diffDatabases(beforeDatabase,afterDatabase) {
    const before=new Map(flattenDatabase(beforeDatabase).map(x=>[x.module+'|'+x.recordKey,x]));
    const after=new Map(flattenDatabase(afterDatabase).map(x=>[x.module+'|'+x.recordKey,x]));
    const changes=[];
    for (const [identity,oldDoc] of before) if (!after.has(identity))
      changes.push({operation:'delete',module:oldDoc.module,recordKey:oldDoc.recordKey,documentId:oldDoc.documentId,baseHash:oldDoc.valueHash});
    for (const [identity,newDoc] of after) {
      const oldDoc=before.get(identity);
      if (!oldDoc || oldDoc.valueHash!==newDoc.valueHash)
        changes.push({operation:'upsert',module:newDoc.module,recordKey:newDoc.recordKey,documentId:newDoc.documentId,baseHash:oldDoc?oldDoc.valueHash:null,valueHash:newDoc.valueHash,kind:newDoc.kind,value:newDoc.value,mapKey:newDoc.mapKey});
    }
    return changes;
  }
  function makeOperationId(change,revision,changedAt) {
    return 'op_'+hash32([change.module,change.recordKey,change.operation,revision,changedAt,change.valueHash||''].join('|'),2166136261)+hash32([change.documentId,changedAt].join('|'),2246822519);
  }
  function buildOperations(beforeDatabase,afterDatabase,revision,changedAt) {
    const at=changedAt||new Date().toISOString();
    return diffDatabases(beforeDatabase,afterDatabase).map(change=>({...change,operationId:makeOperationId(change,revision,at),schemaVersion:SCHEMA_VERSION,revision:Number(revision)||0,changedAt:at}));
  }
  root.MVSSRecordSyncPrep=Object.freeze({schemaVersion:SCHEMA_VERSION,arrayModules:ARRAY_MODULES.slice(),mapModules:MAP_MODULES.slice(),singletonModules:SINGLETON_MODULES.slice(),naturalKey,firestoreId,fingerprint,validateArray,validateDatabase,flattenDatabase,diffDatabases,buildOperations});
})(typeof window!=='undefined'?window:globalThis);

/*
 * MVSS INDIVIDUAL-RECORD SYNC ENGINE — integration component
 * Requires MVSSRecordSyncPrep (bundled above) and Firebase Firestore compat SDK.
 * This engine is intentionally NOT auto-started and does not replace the legacy
 * whole-database publisher until the host app explicitly integrates and tests it.
 */
(function(root){
  'use strict';
  const Prep = root.MVSSRecordSyncPrep;
  const ENGINE_VERSION = 3;
  const DB_NAME = 'MVSS_Individual_Record_Queue_v1';
  const STORE = 'operations';
  const DEFAULT_BATCH = 300;

  const RECEIVER_DB_NAME = 'MVSS_Individual_Record_Receiver_v1';
  const RECEIVER_STORE = 'checkpoints';
  const RECEIVE_PAGE_SIZE = 200;

  function openReceiverStore(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(RECEIVER_DB_NAME,1);
      req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(RECEIVER_STORE))db.createObjectStore(RECEIVER_STORE,{keyPath:'namespace'});};
      req.onsuccess=()=>{const db=req.result;db.onversionchange=()=>db.close();resolve(db);};
      req.onerror=()=>reject(req.error||new Error('Could not open incoming-record checkpoint store.'));
      req.onblocked=()=>reject(new Error('Close other MVSS tabs before opening incoming-record checkpoints.'));
    });
  }
  async function getReceiverCheckpoint(namespace){
    const db=await openReceiverStore();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(RECEIVER_STORE,'readonly'),req=tx.objectStore(RECEIVER_STORE).get(namespace);
      req.onsuccess=()=>{const v=req.result||{namespace,lastChangedAtMs:0,lastOperationId:''};db.close();resolve(v);};
      req.onerror=()=>{const e=req.error;db.close();reject(e||new Error('Could not read incoming-record checkpoint.'));};
    });
  }
  async function putReceiverCheckpoint(value){
    const db=await openReceiverStore();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(RECEIVER_STORE,'readwrite');tx.objectStore(RECEIVER_STORE).put(value);
      tx.oncomplete=()=>{db.close();resolve();};
      tx.onerror=()=>{const e=tx.error;db.close();reject(e||new Error('Could not save incoming-record checkpoint.'));};
      tx.onabort=()=>{const e=tx.error;db.close();reject(e||new Error('Incoming-record checkpoint was aborted.'));};
    });
  }

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
      req.onerror=()=>{const e=req.error;db.close();reject(e||new Error('Could not read individual-record offline queue.'));};
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
      if(!validation.ok) throw new Error('Record migration blocked: '+validation.modules.filter(x=>!x.ok).map(x=>x.module+': '+(x.errors||[]).join('; ')).join(' | '));
      const documents=Prep.flattenDatabase(database);
      return {schemaVersion:Prep.schemaVersion,valid:true,documentCount:documents.length,modules:validation.modules,documents};
    }

    async function migrate(database, progress){
      const report=await inspect(database);
      const docs=report.documents;
      const existingControl=await controlRef.get();
      const existingSync=(existingControl.exists && (existingControl.data()||{}).individualRecordSync)||null;
      if(existingSync && existingSync.migrationStatus==='complete') throw new Error('Migration is already marked complete. Refusing to overwrite individual records. Use an explicit recovery procedure if a restart is required.');
      await controlRef.set({individualRecordSync:{engineVersion:ENGINE_VERSION,schemaVersion:Prep.schemaVersion,migrationStatus:'in_progress',recordCount:docs.length,startedAtMs:Date.now(),namespace,source:'MVSS local database snapshot'}},{merge:true});
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
          recordKey:op.recordKey,operation:op.operation,baseHash:op.baseHash,kind:body.kind,mapKey:body.mapKey,value:body.value,valueHash:body.valueHash,
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
            break;
          }
        }
        results.remaining=(await queueAll()).length;
        return results;
      });
      return flushing;
    }

    function identityOf(doc){return doc.module+'|'+doc.recordKey;}

    function applyEventToDatabase(database,event){
      const next=JSON.parse(JSON.stringify(database||{}));
      const moduleName=event.module,recordKey=event.recordKey;
      if(!moduleName||!recordKey)throw new Error('Incoming event has no module or record identity.');
      if(Array.isArray(next[moduleName])){
        const arr=next[moduleName];
        const matches=arr.filter(item=>Prep.naturalKey(moduleName,item)===recordKey);
        if(matches.length>1)throw new Error('Local duplicate identity detected for '+moduleName+' '+recordKey+'. Incoming update paused.');
        const at=arr.findIndex(item=>Prep.naturalKey(moduleName,item)===recordKey);
        if(event.deleted)throw new Error('Incoming deletion held for review. Local records are never deleted by cloud events.');
        else {if(!event.value||typeof event.value!=='object')throw new Error('Incoming array record payload is invalid.');if(at>=0)arr[at]=event.value;else arr.push(event.value);}
      } else if(event.kind==='map-entry'){
        if(!next[moduleName]||typeof next[moduleName]!=='object'||Array.isArray(next[moduleName]))next[moduleName]={};
        const key=event.mapKey;
        if(key==null)throw new Error('Incoming map record has no map key.');
        if(event.deleted)throw new Error('Incoming map deletion held for review. Local data is never deleted by cloud events.');
        else next[moduleName][key]=event.value;
      } else if(event.kind==='singleton'){
        if(event.deleted)throw new Error('Incoming singleton deletion held for review. Local data is never deleted by cloud events.');
        else next[moduleName]=event.value;
      } else {
        throw new Error('Incoming event kind is not recognised for '+moduleName+'.');
      }
      return next;
    }

    async function receiveChanges(getDatabase,commitDatabase,receiveOptions){
      assert(typeof getDatabase==='function','receiveChanges requires getDatabase().');
      assert(typeof commitDatabase==='function','receiveChanges requires commitDatabase(database,event).');
      receiveOptions=receiveOptions||{};
      const pageSize=Math.max(1,Math.min(400,Number(receiveOptions.pageSize)||RECEIVE_PAGE_SIZE));
      let cursor=await getReceiverCheckpoint(namespace);
      let processed=0;
      const conflicts=[];
      while(true){
        let query=eventsRef.orderBy('changedAtMs','asc').orderBy('operationId','asc').limit(pageSize);
        if(cursor.lastOperationId)query=query.startAfter(Number(cursor.lastChangedAtMs)||0,String(cursor.lastOperationId));
        const snap=await query.get();
        if(snap.empty)break;
        const docs=snap.docs||[];
        for(const eventDoc of docs){
          const event=eventDoc.data()||{};
          const eventId=event.operationId||eventDoc.id;
          if(!eventId||!event.module||!event.recordKey||!Number.isFinite(Number(event.changedAtMs))){
            conflicts.push({eventId,message:'Incoming event is missing required identity or ordering fields.'});return {ok:false,processed,conflicts,checkpoint:cursor};
          }
          if(Number(event.schemaVersion)!==Prep.schemaVersion){
            conflicts.push({eventId,module:event.module,recordKey:event.recordKey,message:'Incoming schema version does not match this app. Update paused safely.'});return {ok:false,processed,conflicts,checkpoint:cursor};
          }
          if(!Object.prototype.hasOwnProperty.call(event,'baseHash')){
            conflicts.push({eventId,module:event.module,recordKey:event.recordKey,message:'Incoming event is from an older writer without a base-hash safety check. Update paused safely.'});return {ok:false,processed,conflicts,checkpoint:cursor};
          }
          const queued=await queueAll();
          const localPending=queued.find(op=>op.module===event.module&&op.recordKey===event.recordKey);
          if(localPending){
            conflicts.push({eventId,module:event.module,recordKey:event.recordKey,message:'This record also has an unsynced local edit. Both copies are preserved for conflict review.'});return {ok:false,processed,conflicts,checkpoint:cursor};
          }
          const database=getDatabase();
          const flat=Prep.flattenDatabase(database);
          const local=flat.find(doc=>identityOf(doc)===event.module+'|'+event.recordKey);
          const localHash=local?local.valueHash:null;
          const alreadyApplied=event.deleted ? !local : !!local&&localHash===event.valueHash;
          if(!alreadyApplied&&localHash!==event.baseHash){
            conflicts.push({eventId,module:event.module,recordKey:event.recordKey,message:'The local record no longer matches the cloud event base. Neither copy was overwritten.'});return {ok:false,processed,conflicts,checkpoint:cursor};
          }
          if(!alreadyApplied){
            const next=applyEventToDatabase(database,event);
            await commitDatabase(next,event);
          }
          cursor={namespace,lastChangedAtMs:Number(event.changedAtMs),lastOperationId:String(eventId)};
          await putReceiverCheckpoint(cursor);
          processed++;
        }
        if(docs.length<pageSize)break;
      }
      return {ok:true,processed,conflicts,checkpoint:cursor};
    }

    function startReceiver(getDatabase,commitDatabase,receiveOptions){
      let stopped=false,running=false,unsubscribe=null,timer=null;
      const interval=Math.max(2000,Number((receiveOptions||{}).pollIntervalMs)||10000);
      const onError=(receiveOptions||{}).onError;
      const onResult=(receiveOptions||{}).onResult;
      async function run(){
        if(stopped||running||!root.navigator?.onLine)return;
        running=true;
        try{
          const result=await receiveChanges(getDatabase,commitDatabase,receiveOptions);
          if(typeof onResult==='function')onResult(result);
          if(!result.ok&&typeof onError==='function')onError(new Error(result.conflicts[0]?.message||'Incoming record conflict'));
        }
        catch(error){if(typeof onError==='function')onError(error);}
        finally{running=false;}
      }
      try{
        const wake=eventsRef.orderBy('changedAtMs','desc').limit(1);
        unsubscribe=wake.onSnapshot(()=>run(),error=>{if(typeof onError==='function')onError(error);});
      }catch(error){if(typeof onError==='function')onError(error);}
      timer=setInterval(run,interval);
      run();
      return function stop(){stopped=true;if(unsubscribe)unsubscribe();if(timer)clearInterval(timer);};
    }

    async function pendingCount(){return (await queueAll()).length;}

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

    return Object.freeze({inspect,migrate,enqueueChanges,flush,pendingCount,listenSince,readRecord,receiveChanges,startReceiver,
      namespace,schemaVersion:Prep.schemaVersion,engineVersion:ENGINE_VERSION});
  }

  root.MVSSIndividualRecordSync = Object.freeze({create,engineVersion:ENGINE_VERSION,schemaVersion:Prep?Prep.schemaVersion:null});
})(typeof window!=='undefined'?window:globalThis);
