/**
 * Mocks the Firebase Firestore module using PocketBase.
 */

// --- Initialization ---

export function getFirestore(app) {
    return app;
}

// --- References ---

export function collection(db, ...pathSegments) {
    const collectionName = pathSegments[pathSegments.length - 1];
    return {
        type: 'collection',
        db: db,
        name: collectionName,
        fullPath: pathSegments
    };
}

export function doc(db, ...pathSegments) {
    let dbInstance = db;
    let collectionName = '';
    let docId = '';

    if (db.type === 'collection') {
        dbInstance = db.db;
        collectionName = db.name;
        docId = pathSegments[0];
    } else {
        docId = pathSegments[pathSegments.length - 1];
        collectionName = pathSegments[pathSegments.length - 2];
    }

    return {
        type: 'document',
        db: dbInstance,
        collectionName: collectionName,
        id: docId
    };
}

// --- Write Operations ---

export async function addDoc(collectionRef, data) {
    const pb = collectionRef.db;
    const colName = collectionRef.name;
    const recordData = transformDataForSave(data);

    const record = await pb.collection(colName).create(recordData);

    return {
        id: record.id,
        path: collectionRef.fullPath ? [...collectionRef.fullPath, record.id].join('/') : colName + '/' + record.id
    };
}

export async function updateDoc(docRef, data) {
    const pb = docRef.db;
    const recordData = transformDataForSave(data);

    await pb.collection(docRef.collectionName).update(docRef.id, recordData);
}

export async function deleteDoc(docRef) {
    const pb = docRef.db;
    await pb.collection(docRef.collectionName).delete(docRef.id);
}

// --- Read / Realtime ---

export function onSnapshot(queryRef, onNext, onError) {
    const pb = queryRef.db;
    const colName = queryRef.name;

    pb.collection(colName).getFullList()
        .then(records => {
            const snapshot = createSnapshot(records);
            onNext(snapshot);
        })
        .catch(err => {
            if (onError) onError(err);
            else console.error("Snapshot initial fetch error:", err);
        });

    const unsubscribePromise = pb.collection(colName).subscribe('*', async (e) => {
        try {
            const records = await pb.collection(colName).getFullList();
            onNext(createSnapshot(records));
        } catch (err) {
            console.error("Snapshot update error:", err);
        }
    });

    return () => {
        unsubscribePromise.then(unsub => unsub());
    };
}

// --- Helpers & Value Objects ---

export function serverTimestamp() {
    return new Date();
}

/**
 * Creates a query reference (just returns the collection for now).
 * In this wrapper, complex queries are not supported - returns collection as-is.
 */
export function query(collectionRef, ...queryConstraints) {
    // For this simple wrapper, we ignore query constraints and return the collection
    // Client-side filtering/sorting is expected
    console.log("[Firebase Wrapper] query called - constraints ignored, using collection directly");
    return collectionRef;
}

/**
 * Mock orderBy - returns a constraint object (ignored in this wrapper).
 */
export function orderBy(fieldPath, direction = 'asc') {
    console.log(`[Firebase Wrapper] orderBy called - ${fieldPath} ${direction} (ignored)`);
    return { type: 'orderBy', field: fieldPath, direction };
}


function createSnapshot(records) {
    const docs = records.map(record => ({
        id: record.id,
        data: () => transformRecordToDocData(record),
        exists: () => true
    }));

    return {
        docs: docs,
        empty: docs.length === 0,
        size: docs.length,
        forEach: (callback) => docs.forEach(callback)
    };
}

function transformRecordToDocData(record) {
    const data = { ...record };

    if (data.created) {
        data.createdAt = toFirebaseTimestamp(data.created);
    }
    if (data.updated) {
        data.updatedAt = toFirebaseTimestamp(data.updated);
    }

    return data;
}

function toFirebaseTimestamp(isoString) {
    const date = new Date(isoString);
    const seconds = Math.floor(date.getTime() / 1000);
    return {
        seconds: seconds,
        nanoseconds: 0,
        toDate: () => date
    };
}

function transformDataForSave(data) {
    const copy = { ...data };
    return copy;
}
