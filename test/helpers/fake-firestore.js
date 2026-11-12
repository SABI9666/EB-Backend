// Minimal in-memory Firestore for route tests (only what ts-portal uses).
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function createFakeFirestore() {
    const store = new Map(); // path -> data
    let auto = 0;

    const snapOf = (path) => {
        const data = store.get(path);
        return { id: path.split('/').pop(), exists: data !== undefined, data: () => clone(data), ref: docRef(path) };
    };

    function docRef(path) {
        return {
            id: path.split('/').pop(), path,
            get: async () => snapOf(path),
            set: async (data, opts) => { store.set(path, opts && opts.merge ? { ...(store.get(path) || {}), ...clone(data) } : clone(data)); },
            update: async (data) => {
                if (!store.has(path)) { const e = new Error('NOT_FOUND: ' + path); e.code = 5; throw e; }
                store.set(path, { ...store.get(path), ...clone(data) });
            },
            delete: async () => { store.delete(path); },
            collection: name => colRef(`${path}/${name}`)
        };
    }

    function query(path, filters) {
        const run = () => {
            const depth = path.split('/').length + 1;
            const out = [];
            for (const [p, data] of store) {
                if (!p.startsWith(path + '/') || p.split('/').length !== depth) continue;
                const ok = filters.every(([f, op, v]) => {
                    const x = data[f];
                    if (op === '==') return x === v;
                    if (op === '>=') return x !== undefined && x >= v;
                    if (op === '<=') return x !== undefined && x <= v;
                    if (op === 'array-contains') return Array.isArray(x) && x.includes(v);
                    throw new Error('op not supported: ' + op);
                });
                if (ok) out.push(snapOf(p));
            }
            return { docs: out, size: out.length, empty: !out.length };
        };
        return {
            _isQuery: true, run,
            where: (f, op, v) => query(path, [...filters, [f, op, v]]),
            get: async () => run()
        };
    }

    function colRef(path) {
        const q = query(path, []);
        return {
            ...q, path,
            doc: id => docRef(`${path}/${id || 'auto' + (++auto)}`),
            add: async data => { const r = docRef(`${path}/auto${++auto}`); await r.set(data); return r; }
        };
    }

    // Transactions run serially; writes are applied after the callback succeeds.
    let chain = Promise.resolve();
    function runTransaction(fn) {
        const job = chain.then(async () => {
            const writes = [];
            const tx = {
                get: async ref => (ref._isQuery ? ref.run() : ref.get()),
                set: (ref, data, opts) => writes.push(() => ref.set(data, opts)),
                update: (ref, data) => writes.push(() => ref.update(data))
            };
            const result = await fn(tx);
            for (const w of writes) await w();
            return result;
        });
        chain = job.catch(() => {});
        return job;
    }

    return { collection: name => colRef(name), runTransaction, _store: store };
}

// Fake Firebase Auth: tokens are "tok-<uid>".
function createFakeAuth() {
    const users = new Map(); // uid -> { uid, email }
    let n = 0;
    return {
        users,
        addUser(email, uid) { uid = uid || 'u' + (++n); users.set(uid, { uid, email }); return uid; },
        verifyIdToken: async tok => {
            const uid = String(tok).replace(/^tok-/, '');
            const u = users.get(uid);
            if (!u) throw new Error('bad token');
            return { uid, email: u.email };
        },
        getUserByEmail: async email => {
            const u = [...users.values()].find(x => x.email === email);
            if (!u) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
            return u;
        },
        createUser: async ({ email }) => { const uid = 'new' + (++n); users.set(uid, { uid, email }); return { uid, email }; },
        generatePasswordResetLink: async email => `https://reset.example/${encodeURIComponent(email)}`
    };
}

module.exports = { createFakeFirestore, createFakeAuth };
