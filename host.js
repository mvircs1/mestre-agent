import { ID, NOTEBOOK_SIZE, decodeState, fold, requireValue, text } from './data.js';

const KEY = 'notebook';

export function refKey(ref) {
    if (!ref) return null;
    return JSON.stringify(ref.kind === 'group' ? ['group', ref.chatId] : ['character', ref.characterId, ref.fileName]);
}

async function request(context, path, data) {
    const response = await fetch(path, {
        method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(data), cache: 'no-store',
    });
    requireValue(response.ok, 'O Tavern retornou HTTP ' + response.status + ' em ' + path + '.');
    return response.json();
}

export function createHost(api, getContext, loadWorld = () => import('/scripts/world-info.js')) {
    let modulePromise;
    const world = () => modulePromise ??= loadWorld().catch(error => {
        modulePromise = undefined;
        throw error;
    });

    function active() {
        const context = getContext();
        if (!context.chatId) return null;
        const handle = api.chat.current.handle();
        const key = refKey(handle.ref);
        const meta = context.chatMetadata;
        const stableId = handle.ref.kind === 'group' ? handle.ref.chatId : meta?.integrity;
        const identity = stableId ? JSON.stringify([key, stableId]) : key;
        return { ref: handle.ref, key, identity, stableId, handle, active: true, nativeBook: meta?.world_info || '' };
    }

    function displayed() {
        try { return active(); }
        catch { return null; }
    }

    function target(run) {
        requireValue(run?.target?.kind === 'chat', 'Use a ferramenta numa conversa do TauriTavern.');
        const handle = api.chat.open(run.target.chatRef);
        return { ref: handle.ref, key: refKey(handle.ref), handle, stableId: run.target.stableChatId,
            runId: run.runId, invocationId: run.invocationId, callId: run.callId, signal: run.signal };
    }

    async function ensureIdentity(binding, { afterCommit = false } = {}) {
        requireValue(afterCommit || !binding.signal?.aborted, 'A execução foi cancelada.');
        requireValue(afterCommit || !binding.active || displayed()?.identity === binding.identity, 'A conversa mudou. Reabra o registro no chat atual.');
        if (binding.stableId) {
            requireValue(await binding.handle.stableId() === binding.stableId, 'A conversa de origem mudou desde o início da execução.');
        }
        requireValue(afterCommit || !binding.signal?.aborted, 'A execução foi cancelada.');
    }

    async function read(binding) {
        await ensureIdentity(binding);
        const keys = await binding.handle.store.listKeys({ namespace: ID });
        if (!keys.includes(KEY)) return decodeState(null);
        return decodeState(await binding.handle.store.getJson({ namespace: ID, key: KEY }));
    }

    async function write(binding, state, options) {
        await ensureIdentity(binding, options);
        requireValue(JSON.stringify(state).length <= NOTEBOOK_SIZE, 'O caderno atingiu o tamanho suportado. Reduza os textos antes de continuar.');
        return binding.handle.store.setJson({ namespace: ID, key: KEY, value: state });
    }

    async function nativeBook(binding) {
        const visible = displayed();
        if (visible?.key === binding.key) return visible.nativeBook;
        return (await binding.handle.metadata.get())?.world_info || '';
    }

    async function confirmBookAccess(binding, state) {
        const native = await nativeBook(binding);
        return state.books.some(book => book.access === 'write')
            || Boolean(native && state.books.find(book => book.name === native)?.access === 'write');
    }

    function names() {
        return getContext().getWorldInfoNames();
    }

    async function freshNames() {
        const data = await request(getContext(), '/api/settings/get', {});
        requireValue(Array.isArray(data.world_names), 'O Tavern não devolveu a lista de Lorebooks.');
        return data.world_names;
    }

    async function sanitizeName(input) {
        const name = text(input, 100, 'Nome do Lorebook');
        const canonical = (await request(getContext(), '/api/worldinfo/sanitize-name', { name })).name;
        requireValue(canonical === name, 'O nome contém caracteres que o Tavern removeria. Escolha um nome simples.');
        return name;
    }

    async function readBook(name, { disk = false } = {}) {
        const data = disk ? await request(getContext(), '/api/worldinfo/get', { name }) : await getContext().loadWorldInfo(name);
        requireValue(data?.entries && typeof data.entries === 'object', 'O livro não contém entradas válidas.');
        return structuredClone(data);
    }

    async function saveBook(name, document) {
        const context = getContext();
        await context.saveWorldInfo(name, document, true);
    }

    async function settleBook(name, created) {
        const context = getContext();
        if (created) await context.updateWorldInfoList();
        context.reloadWorldInfoEditor(name);
    }

    async function flushBook(name) {
        const native = await world();
        await native.flushWorldInfoSaves('mestre-agent', [name]);
    }

    async function resetBookCache(name, exists) {
        if (!exists) {
            const persistence = await import('/scripts/world-info-persistence.js');
            persistence.discardWorldInfoDocument(name);
            return;
        }
        const native = await world();
        await native.refreshWorldInfoAfterExternalWrite(name);
    }

    async function createEntry(name, document) {
        const native = await world();
        const entry = native.createWorldInfoEntry(name, document);
        requireValue(entry && Number.isSafeInteger(entry.uid), 'O Tavern não conseguiu atribuir um UID para a entrada.');
        return entry;
    }

    async function existing(name, { refresh = false } = {}) {
        const listed = refresh ? await freshNames() : names();
        return listed.includes(name);
    }

    async function requireUnique(name) {
        const all = await freshNames();
        requireValue(!all.some(book => fold(book) === fold(name)), 'Já existe um Lorebook com este nome.');
    }

    async function openEntry(book, uid) {
        const result = await api.worldInfo?.openEntry?.({ world: book, uid });
        requireValue(result?.opened, 'O Tavern não conseguiu abrir esta entrada.');
    }

    return {
        active: displayed, target, ensureIdentity, read, write, nativeBook, names, existing, sanitizeName, requireUnique,
        readBook, saveBook, settleBook, flushBook, resetBookCache, createEntry, openEntry,
    };
}
