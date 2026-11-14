import { NOTEBOOK_SIZE, bool, bookAccess, canonical, digest, editNotebook, entryKey, oneOf, requireValue, text } from './data.js';
import { changeEntries, readEntry, restoreEntries, snapshot } from './lore.js';

const HISTORY_LIMIT = 100;
const UNDO_LIMIT = 20;

function pruneSnapshots(state) {
    const snapshots = state.history.filter(item => item.changes || item.notebookUndo);
    const dropSnapshot = item => {
        delete item.changes;
        delete item.notebookUndo;
    };
    for (const old of snapshots.splice(0, Math.max(0, snapshots.length - UNDO_LIMIT))) dropSnapshot(old);
    while (JSON.stringify(state).length > NOTEBOOK_SIZE && snapshots.length) dropSnapshot(snapshots.shift());
}

function append(state, entry, request) {
    state.revision++;
    const record = { id: crypto.randomUUID(), at: new Date().toISOString(), revision: state.revision, ...entry };
    if (request) {
        record.request = request.key;
        record.signature = request.signature;
    }
    state.history = [...state.history, record].slice(-HISTORY_LIMIT);
    pruneSnapshots(state);
    return record;
}

function publicRecord(entry) {
    const { changes, notebookUndo, request, signature, ...visible } = entry;
    return { ...visible, undoable: Boolean((changes || notebookUndo) && !entry.undoneAt) };
}

export function journal(state) {
    return state.history.slice().reverse().map(publicRecord);
}

function repeated(state, request) {
    if (!request) return null;
    const item = state.history.find(entry => entry.request === request.key);
    if (!item) return null;
    requireValue(item.signature === request.signature, 'Esse ID de ação já foi usado com outros dados nesta execução.');
    requireValue(!item.undoneAt, 'O jogador desfez esta ação.');
    return { ...item.result, repeated: true, revision: item.revision ?? state.revision, current_revision: state.revision, history_id: item.id };
}

function signal(binding) {
    requireValue(!binding.signal?.aborted, 'A execução foi cancelada.');
}

function bookmarkId(binding, actionId, signature) {
    if (!binding.runId) return undefined;
    const label = text(actionId, 80, 'ID da ação');
    return { key: JSON.stringify([binding.runId, label]), signature };
}

export function createService(host, onChange = () => {}) {
    let previous = Promise.resolve();

    function within(task) {
        const next = previous.then(task);
        previous = next.catch(() => {});
        return next;
    }

    function publish(binding, state) {
        try { onChange(binding, state); }
        catch (error) { console.error('[Mestre] Não foi possível atualizar o painel.', error); }
    }

    function nativeBook(binding) { return host.nativeBook(binding); }

    function checkedBook(name) {
        requireValue(typeof name === 'string' && name.length > 0 && name.length <= 256, 'Informe o nome exato do Lorebook.');
        return name;
    }

    async function permission(binding, state, name, mode) {
        if (!binding.runId) return;
        const access = bookAccess(state, name, await nativeBook(binding));
        requireValue(access === 'write' || (mode === 'read' && access === 'read'),
            'O livro “' + name + '” precisa de acesso de ' + (mode === 'read' ? 'leitura' : 'escrita') + ' nesta conversa. Abra Mestre → Lorebooks.');
    }

    async function inspectCommit(pending) {
        const exists = await host.existing(pending.book, { refresh: true });
        if (!exists) return { exists, status: pending.type === 'create' ? 'unchanged' : 'conflict' };
        const document = await host.readBook(pending.book, { disk: true });
        if (pending.type === 'create') {
            return { exists, status: await digest(document) === pending.expected ? 'applied' : 'conflict' };
        }
        const entries = canonical(pending.changes.map(({ uid }) => snapshot(document, uid)));
        for (const [key, status] of [['after', 'applied'], ['before', 'unchanged']]) {
            if (entries === canonical(pending.changes.map(change => change[key]))) return { exists, status };
        }
        return { exists, status: 'conflict' };
    }

    async function finalize(binding, state, pending) {
        if (pending.type === 'create') {
            state.books = state.books.filter(book => book.name !== pending.book);
            state.books.push({ name: pending.book, access: 'write', include: pending.include });
        }
        if (pending.restores) {
            const restored = state.history.find(item => item.id === pending.restores);
            if (restored) restored.undoneAt = new Date().toISOString();
        }
        const { label, book, result } = pending;
        state.pending = null;
        const item = append(state, {
            label, book, actor: pending.actor, result,
            ...(pending.type === 'edit' ? { changes: pending.changes } : {}),
        }, pending.request);
        await host.write(binding, state, { afterCommit: true });
        try { await host.settleBook(pending.book, pending.type === 'create'); }
        catch (error) { console.warn('[Mestre] O Lorebook foi salvo, mas o editor não atualizou.', error); }
        publish(binding, state);
        return { ...result, revision: state.revision, history_id: item.id };
    }

    async function recover(binding, state) {
        const pending = state.pending;
        if (!pending) return state;
        signal(binding);
        await host.flushBook(pending.book);
        const disk = await inspectCommit(pending);
        if (disk.status === 'applied') {
            await finalize(binding, state, pending);
            return state;
        }
        requireValue(disk.status === 'unchanged', 'Uma gravação do Mestre ficou pendente e a entrada mudou em seguida. Confira o livro no editor do Tavern antes de liberar o registro.');
        state.pending = null;
        await host.write(binding, state);
        publish(binding, state);
        return state;
    }

    async function prepared(binding) {
        const state = await host.read(binding);
        return recover(binding, state);
    }

    async function commit(binding, state, pending, document, verify) {
        signal(binding);
        state.pending = pending;
        pruneSnapshots(state);
        await host.write(binding, state);
        const intended = canonical(document);
        let attempted = false;
        try {
            signal(binding);
            await verify();
            await host.ensureIdentity(binding);
            attempted = true;
            await host.saveBook(pending.book, document);
        } catch (error) {
            try {
                const disk = attempted ? await inspectCommit(pending) : null;
                if (disk?.status === 'applied') return await finalize(binding, state, pending);
                if (!attempted || disk.status === 'unchanged') {
                    if (attempted && canonical(await host.readBook(pending.book)) === intended) {
                        await host.resetBookCache(pending.book, disk.exists);
                    }
                    state.pending = null;
                    await host.write(binding, state, { afterCommit: true });
                }
            } catch (recoveryError) {
                console.warn('[Mestre] A confirmação da gravação ficou pendente.', recoveryError);
            }
            publish(binding, state);
            throw error;
        }
        try { return await finalize(binding, state, pending); }
        catch (error) {
            throw new Error('O Lorebook foi salvo. O histórico será reconciliado ao conferir a gravação ou tentar a próxima edição. ' + (error?.message || error));
        }
    }

    function state(binding) {
        return within(() => host.read(binding));
    }

    function checkPending(binding) {
        return within(() => prepared(binding));
    }

    function access(binding, name, value, included) {
        return within(async () => {
            requireValue(!binding.runId, 'O acesso a livros é definido pelo jogador no painel.');
            checkedBook(name);
            oneOf(value, ['read', 'write', 'hidden'], 'Acesso');
            const state = await prepared(binding);
            const current = state.books.find(book => book.name === name);
            if (!current) requireValue(await host.existing(name, { refresh: true }), 'O Lorebook não existe.');
            const include = included === undefined ? Boolean(current?.include) && value !== 'hidden' : bool(included, 'Incluir no contexto');
            requireValue(value !== 'hidden' || !include, 'Libere a leitura do livro para incluí-lo no contexto.');
            if (current?.access === value && Boolean(current.include) === include) return state;
            const before = structuredClone(current ?? null);
            if (current) {
                current.access = value;
                current.include = include;
            } else {
                requireValue(state.books.length < 200, 'Este chat já tem 200 vínculos de Lorebook.');
                state.books.push({ name, access: value, include });
            }
            const after = state.books.find(book => book.name === name);
            append(state, { label: 'Acesso · ' + name, actor: 'player', result: { name, access: value, included: include },
                notebookUndo: { kind: 'book', id: name, before, after: await digest(after) } });
            await host.write(binding, state);
            publish(binding, state);
            return state;
        });
    }

    function link(binding, name, included, actionId) {
        return within(async () => {
            checkedBook(name);
            bool(included, 'Incluir no contexto');
            const state = await prepared(binding);
            const request = bookmarkId(binding, actionId, binding.runId ? await digest(['link', name, included]) : undefined);
            const cached = repeated(state, request);
            if (cached) return cached;
            await permission(binding, state, name, 'write');
            requireValue(await host.existing(name), 'O Lorebook não foi encontrado.');
            let current = state.books.find(book => book.name === name);
            const before = structuredClone(current ?? null);
            if (!current && included) {
                requireValue(state.books.length < 200, 'Este chat já tem 200 vínculos de Lorebook.');
                current = { name, access: 'read', include: false };
                state.books.push(current);
            }
            const result = { book: name, included, native_book: await nativeBook(binding) === name };
            if (!current || Boolean(current.include) === included) return result;
            requireValue(current.access !== 'hidden' || !included, 'Libere a leitura do livro para incluí-lo no contexto.');
            current.include = included;
            const item = append(state, { label: (included ? 'Incluído no contexto · ' : 'Removido do contexto do Mestre · ') + name,
                actor: binding.runId ? 'agent' : 'player', book: name, result,
                notebookUndo: { kind: 'book', id: name, before, after: await digest(current) } }, request);
            await host.write(binding, state);
            publish(binding, state);
            return { ...result, history_id: item.id };
        });
    }

    function notebook(binding, command, revision, actionId) {
        return within(async () => {
            const state = await prepared(binding);
            requireValue(!binding.runId || command.op !== 'remove', 'Arquive a nota para tirá-la do caderno ativo.');
            const request = bookmarkId(binding, actionId, binding.runId ? await digest(command) : undefined);
            const cached = repeated(state, request);
            if (cached) return cached;
            requireValue(revision === state.revision, 'O caderno mudou. Consulte a revisão atual antes de editar.');
            const before = { scene: structuredClone(state.scene), notes: structuredClone(state.notes) };
            const { label, result } = editNotebook(state, command);
            if (command.op === 'scene') result.scene = structuredClone(result.scene);
            const undo = command.op === 'scene' ? { kind: 'scene', before: before.scene, after: await digest(state.scene) }
                : { kind: 'note', id: command.id, before: before.notes.find(note => note.id === command.id) ?? null,
                    after: await digest(state.notes.find(note => note.id === command.id) ?? null) };
            const item = append(state, { label, actor: binding.runId ? 'agent' : 'player', result, notebookUndo: undo }, request);
            await host.write(binding, state);
            publish(binding, state);
            return { ...result, revision: state.revision, history_id: item.id };
        });
    }

    function create(binding, requestedName, actionId, initialEntries = [], include = true) {
        return within(async () => {
            const state = await prepared(binding);
            const name = await host.sanitizeName(requestedName);
            bool(include, 'Incluir no contexto');
            requireValue(Array.isArray(initialEntries) && initialEntries.length <= 10, 'Use até 10 entradas iniciais.');
            requireValue(state.books.some(book => book.name === name) || state.books.length < 200, 'Este chat já tem 200 vínculos de Lorebook.');
            const request = bookmarkId(binding, actionId, binding.runId ? await digest(['create', name, initialEntries, include]) : undefined);
            const cached = repeated(state, request);
            if (cached) return cached;
            await host.requireUnique(name);
            const document = { entries: {} };
            const operations = initialEntries.map(patch => ({ op: 'add', fields: patch }));
            const entries = operations.length ? (await changeEntries(name, document, operations, digest, host.createEntry)).result : [];
            const pending = { type: 'create', book: name, actor: binding.runId ? 'agent' : 'player', request, include,
                label: 'Lorebook criado · ' + name, result: { book: name, access: 'write', included: include, entries }, expected: await digest(document) };
            return commit(binding, state, pending, document, () => host.requireUnique(name));
        });
    }

    async function bookDraft(name) {
        await host.flushBook(name);
        const document = await host.readBook(name);
        const baseline = canonical(document);
        const verify = async () => {
            const disk = await host.readBook(name, { disk: true });
            const latest = await host.readBook(name);
            requireValue(canonical(disk) === baseline && canonical(latest) === baseline,
                'O livro mudou durante a edição. Atualize o editor do Tavern e leia as entradas novamente.');
        };
        return { document, verify };
    }

    function inspect(binding, book, uid, options = {}) {
        return within(async () => {
            const state = await host.read(binding);
            const name = checkedBook(book);
            await permission(binding, state, name, 'read');
            requireValue(await host.existing(name), 'O Lorebook “' + name + '” não foi encontrado.');
            const document = await host.readBook(name);
            if (uid === undefined) return { name, document };
            const key = entryKey(uid);
            const entry = readEntry(document, key, options);
            return { ...entry, book: name, revision: await digest(snapshot(document, key)) };
        });
    }

    function change(binding, book, operations, actionId) {
        return within(async () => {
            const state = await prepared(binding);
            const name = checkedBook(book);
            const request = bookmarkId(binding, actionId, binding.runId ? await digest([name, operations]) : undefined);
            const cached = repeated(state, request);
            if (cached) return cached;
            await permission(binding, state, name, 'write');
            requireValue(await host.existing(name, { refresh: true }), 'O Lorebook “' + name + '” não foi encontrado.');
            const { document, verify } = await bookDraft(name);
            const { changes, result: entries } = await changeEntries(name, document, operations, digest, host.createEntry);
            const actual = changes.filter(item => canonical(item.before) !== canonical(item.after));
            if (!actual.length) return { book: name, entries, unchanged: true, revision: state.revision };
            const single = entries.find(item => item.uid === actual[0].uid);
            const label = actual.length === 1 ? { add: 'Entrada criada', edit: 'Entrada editada', remove: 'Entrada excluída' }[single.op]
                + ' · ' + single.title : actual.length + ' alterações no Lorebook';
            const pending = { type: 'edit', book: name, actor: binding.runId ? 'agent' : 'player', request,
                changes: actual, label, result: { book: name, entries } };
            return commit(binding, state, pending, document, verify);
        });
    }

    function undo(binding, itemId) {
        return within(async () => {
            requireValue(!binding.runId, 'Use o painel para restaurar dados do mestre.');
            const state = await prepared(binding);
            const item = state.history.find(entry => entry.id === itemId);
            requireValue(item && !item.undoneAt, 'Mudança indisponível para restaurar.');
            if (item.notebookUndo) {
                const recovery = item.notebookUndo;
                if (recovery.kind === 'scene') {
                    requireValue(await digest(state.scene) === recovery.after, 'A cena mudou desde essa operação.');
                    state.scene = recovery.before;
                } else {
                    const isBook = recovery.kind === 'book';
                    const records = isBook ? state.books : state.notes;
                    const index = records.findIndex(value => (isBook ? value.name : value.id) === recovery.id);
                    requireValue(await digest(records[index] ?? null) === recovery.after, 'O registro mudou desde essa operação.');
                    if (isBook && recovery.before) requireValue(await host.existing(recovery.id, { refresh: true }), 'O Lorebook foi removido ou renomeado.');
                    if (index >= 0 && recovery.before) records[index] = recovery.before;
                    else if (index >= 0) records.splice(index, 1);
                    else if (recovery.before) {
                        requireValue(records.length < 200, 'Reduza o número de registros para restaurar este item.');
                        records.push(recovery.before);
                    }
                }
                item.undoneAt = new Date().toISOString();
                append(state, { label: 'Restaurado · ' + item.label, actor: 'player', result: { restored: item.id } });
                await host.write(binding, state);
                publish(binding, state);
                return { restored: item.id };
            }
            requireValue(item.changes?.length, 'Esta mudança está fora do histórico de restauração.');
            requireValue(await host.existing(item.book, { refresh: true }), 'O Lorebook original já foi removido ou renomeado.');
            const { document, verify } = await bookDraft(item.book);
            restoreEntries(document, item.changes);
            const changes = item.changes.map(change => ({ ...change, before: change.after, after: change.before }));
            const pending = { type: 'restore', actor: 'player', book: item.book, restores: item.id, changes,
                label: 'Restaurado · ' + item.label, result: { restored: item.id, book: item.book } };
            return commit(binding, state, pending, document, verify);
        });
    }

    function clearPending(binding) {
        return within(async () => {
            requireValue(!binding.runId, 'Use o painel para revisar uma gravação pendente.');
            const state = await host.read(binding);
            requireValue(state.pending, 'Nenhuma gravação pendente.');
            const { book } = state.pending;
            const current = await inspectCommit(state.pending);
            if (current.status === 'applied') return finalize(binding, state, state.pending);
            state.pending = null;
            append(state, { label: 'Registro pendente liberado · ' + book, actor: 'player', book, result: {} });
            await host.write(binding, state);
            publish(binding, state);
            return { book };
        });
    }

    return {
        state, checkPending, notebook, access, link, inspect, create, change, undo, clearPending, nativeBook,
    };
}
