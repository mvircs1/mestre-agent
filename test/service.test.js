import assert from 'node:assert/strict';
import test from 'node:test';
import { blankState, generalPrompt } from '../data.js';
import { createHost } from '../host.js';
import { listEntries } from '../lore.js';
import { createService, journal } from '../service.js';
import { registerTools } from '../tools.js';

const player = key => ({ key });
const agent = (key, runId = 'run-1') => ({ key, runId });

function fixture() {
    const states = new Map();
    const books = new Map([['Costa', {
        source: { vendor: 'Tavern' },
        entries: {
            0: { uid: 0, comment: 'Porto', content: 'A maré sobe.', key: ['Porto'], order: 100, extensions: { external: true } },
            1: { uid: 1, comment: 'Mercado', content: 'Armazém da guilda.', key: ['guilda'] },
        },
        originalData: { entries: [{ id: 0, comment: 'Porto', content: 'A maré sobe.', keys: ['Porto'], enabled: true,
            extensions: { external: true } }] },
    }]]);
    const io = {
        writes: 0,
        saves: 0,
        failFinal: false,
        failBook: false,
        loseAck: false,
        afterPending: null,
        names: () => [...books.keys()],
        existing: async name => books.has(name),
        sanitizeName: async name => name.trim(),
        requireUnique: async name => { assert.ok(![...books.keys()].some(book => book.toLowerCase() === name.toLowerCase()), 'Já existe um livro.'); },
        read: async binding => structuredClone(states.get(binding.key) ?? blankState()),
        write: async (binding, state) => {
            io.writes++;
            if (io.failFinal && !state.pending && states.get(binding.key)?.pending) {
                io.failFinal = false;
                throw new Error('falha ao salvar o histórico');
            }
            states.set(binding.key, structuredClone(state));
            if (state.pending) io.afterPending?.();
        },
        nativeBook: async binding => binding.key === 'a' ? 'Costa' : '',
        readBook: async name => structuredClone(books.get(name) ?? { entries: {} }),
        saveBook: async (name, data) => {
            if (io.failBook) throw new Error('falha ao salvar o livro');
            io.saves++;
            books.set(name, structuredClone(data));
            if (io.loseAck) {
                io.loseAck = false;
                throw new Error('resposta perdida');
            }
        },
        settleBook: async () => {},
        ensureIdentity: async binding => { if (binding.signal?.aborted) throw new Error('A execução foi cancelada.'); },
        flushBook: async () => {},
        resetBookCache: async () => {},
        createEntry: async (_name, data) => {
            let uid = 0;
            while (Object.hasOwn(data.entries, uid)) uid++;
            return data.entries[uid] = { uid, key: [], keysecondary: [], comment: '', content: '', order: 100, position: 0, disable: false };
        },
    };
    const service = createService(io);
    return { io, service, states, books };
}

const grant = service => service.access(player('a'), 'Costa', 'write', true);
const edit = (entry, patch) => ({ op: 'edit', uid: entry.uid, revision: entry.revision, fields: patch });
const add = (title, content = 'Texto em World Info.') => ({ op: 'add', fields: { title, content } });

test('the Agent can edit the native chat book; the player can change or revoke access by chat', async () => {
    const { service } = fixture();
    const entry = await service.inspect(agent('a'), 'Costa', '0');
    assert.equal(entry.content, 'A maré sobe.');
    await assert.rejects(service.inspect(agent('b'), 'Costa', '0'), /acesso de leitura/);
    assert.equal((await service.change(agent('a'), 'Costa', [edit(entry, { title: 'Porto da cidade' })], 'native')).entries[0].title, 'Porto da cidade');
    await service.access(player('a'), 'Costa', 'read');
    await assert.rejects(service.change(agent('a'), 'Costa', [edit(entry, { title: 'Novo porto' })], 'write'), /acesso de escrita/);
    await assert.rejects(service.access(agent('a'), 'Costa', 'write'), /definido pelo jogador/);
    await grant(service);
    const latest = await service.inspect(agent('a'), 'Costa', '0');
    assert.equal((await service.change(agent('a'), 'Costa', [edit(latest, { title: 'Novo porto' })], 'write')).entries[0].title, 'Novo porto');
    await service.access(player('a'), 'Costa', 'hidden');
    await assert.rejects(service.inspect(agent('a'), 'Costa', '0'), /acesso de leitura/);
});

test('Agent batch updates native fields and preserves unrelated and original-data fields', async () => {
    const { service, books, io } = fixture();
    await grant(service);
    const before = await service.inspect(agent('a'), 'Costa', '0');
    const result = await service.change(agent('a'), 'Costa', [
        edit(before, { title: 'Porto noturno', content: 'Entrada fechada.\n', keywords: ['Porto', 'Noite', 'Porto'],
            secondary: ['Chave'], logic: 'all', position: 'depth', depth: 3, role: 'system', probability: null }),
        add('Rascunho'),
    ], 'batch');
    assert.equal(io.saves, 1);
    assert.equal(result.entries.length, 2);
    const document = books.get('Costa');
    assert.deepEqual(document.source, { vendor: 'Tavern' });
    assert.equal(document.entries[1].content, 'Armazém da guilda.');
    assert.deepEqual(document.entries[0].extensions, { external: true });
    assert.deepEqual(document.entries[0].key, ['Porto', 'Noite']);
    assert.equal(document.entries[0].selectiveLogic, 3);
    assert.equal(document.entries[0].useProbability, false);
    assert.equal(document.entries[2].disable, true);
    assert.equal(document.originalData.entries[0].comment, 'Porto noturno');
    assert.equal(document.originalData.entries[0].extensions.depth, 3);
    assert.equal(document.originalData.entries[1].enabled, false);
    assert.equal(listEntries(document, { query: 'FECHADA' }).items[0].uid, '0');
});

test('bad fields and stale revisions reject a full batch before any book is saved', async () => {
    const { service, books, io } = fixture();
    await grant(service);
    const entry = await service.inspect(agent('a'), 'Costa', '0');
    await assert.rejects(service.change(agent('a'), 'Costa', [add('Temporário'), edit(entry, { automationId: '/script' })], 'failed'), /Campo desconhecido/);
    assert.equal(books.get('Costa').entries[2], undefined);
    books.get('Costa').entries[0].content = 'Alteração no editor';
    await assert.rejects(service.change(agent('a'), 'Costa', [edit(entry, { title: 'Antigo' })], 'old'), /mudou/);
    assert.equal(io.saves, 0);
});

test('a book created by the Agent is native, included by default, and action retries do not duplicate it', async () => {
    const { service, books, io } = fixture();
    const patch = { title: 'Mensagem no cais', content: 'A capitã partiu.', keywords: ['capitã'] };
    const result = await service.create(agent('b'), 'Caderno da Costa', 'created', [patch]);
    assert.equal(result.included, true);
    assert.equal(books.get('Caderno da Costa').entries[0].content, 'A capitã partiu.');
    assert.deepEqual((await service.state(player('b'))).books, [{ name: 'Caderno da Costa', access: 'write', include: true }]);
    assert.equal((await service.state(player('a'))).books.length, 0);
    assert.equal((await service.create(agent('b'), 'Caderno da Costa', 'created', [patch])).repeated, true);
    assert.equal(io.saves, 1);
    await assert.rejects(service.create(agent('b'), 'Caderno da Costa', 'new'), /Já existe/);
    await service.link(agent('b'), 'Caderno da Costa', false, 'next-chapter');
    assert.equal((await service.state(player('b'))).books[0].include, false);
});

test('undo restores a deleted entry and rejects overwriting later edits to the same entry', async () => {
    const { service, books } = fixture();
    await grant(service);
    const entry = await service.inspect(agent('a'), 'Costa', '0');
    const deletion = await service.change(agent('a'), 'Costa', [{ op: 'remove', uid: '0', revision: entry.revision }], 'remove');
    assert.equal(books.get('Costa').entries[0], undefined);
    assert.equal(books.get('Costa').originalData.entries.length, 0);
    books.get('Costa').entries[1].content = 'Mudança independente.';
    await service.undo(player('a'), deletion.history_id);
    assert.equal(books.get('Costa').entries[0].content, 'A maré sobe.');
    assert.equal(books.get('Costa').originalData.entries[0].id, 0);
    assert.equal(books.get('Costa').entries[1].content, 'Mudança independente.');
    const updated = await service.change(agent('a'), 'Costa', [edit(await service.inspect(agent('a'), 'Costa', '0'), { content: 'Atualizado.' })], 'new');
    books.get('Costa').entries[0].content = 'Revisão manual.';
    await assert.rejects(service.undo(player('a'), updated.history_id), /mudou depois/);
    assert.equal(books.get('Costa').entries[0].content, 'Revisão manual.');
});

test('pre-save conflicts do not discard the native edit or leave a pending journal entry', async () => {
    const { service, books, io, states } = fixture();
    await grant(service);
    const entry = await service.inspect(agent('a'), 'Costa', '0');
    io.afterPending = () => { books.get('Costa').entries[1].content = 'Edição concorrente do Tavern'; };
    await assert.rejects(service.change(agent('a'), 'Costa', [edit(entry, { content: 'Mudança do Agent' })], 'change'), /mudou durante/);
    assert.equal(books.get('Costa').entries[1].content, 'Edição concorrente do Tavern');
    assert.equal(io.saves, 0);
    assert.equal(states.get('a').pending, null);
});

test('proven save failures clear pending; an unacknowledged write is recorded only once', async () => {
    const { service, books, io, states } = fixture();
    await grant(service);
    const input = [add('Ponte')];
    io.failBook = true;
    await assert.rejects(service.change(agent('a'), 'Costa', input, 'create'), /falha ao salvar o livro/);
    assert.equal(states.get('a').pending, null);
    assert.equal(books.get('Costa').entries[2], undefined);
    io.failBook = false;
    io.loseAck = true;
    const applied = await service.change(agent('a'), 'Costa', input, 'create');
    assert.equal(applied.entries[0].uid, '2');
    assert.equal((await service.change(agent('a'), 'Costa', input, 'create')).repeated, true);
    assert.equal(io.saves, 1);
});

test('interrupted history confirmation is reconciled when the same operation is retried', async () => {
    const { service, books, io, states } = fixture();
    await grant(service);
    io.failFinal = true;
    const input = [add('Lenda do farol')];
    await assert.rejects(service.change(agent('a'), 'Costa', input, 'new'), /O Lorebook foi salvo/);
    assert.ok(states.get('a').pending);
    assert.equal(books.get('Costa').entries[2].comment, 'Lenda do farol');
    const retried = await service.change(agent('a'), 'Costa', input, 'new');
    assert.equal(retried.repeated, true);
    assert.equal(io.saves, 1);
    assert.equal((await service.state(player('a'))).pending, null);
});

test('scene, secret notes, and clocks persist by chat and keep the prompt concise', async () => {
    const { service } = fixture();
    let result = await service.notebook(agent('a'), { op: 'scene', fields: { location: 'Porto', stakes: 'A maré sobe' } }, 0, 'scene');
    result = await service.notebook(agent('a'), { op: 'note', id: 'sinal', fields: { title: 'Sinal no farol', kind: 'thread',
        clock: { value: 1, max: 4 }, content: 'A guarda emite sinais.' } }, result.revision, 'thread');
    result = await service.notebook(agent('a'), { op: 'note', id: 'espia', fields: { title: 'O espião', kind: 'secret',
        content: 'O espião é a capitã.' } }, result.revision, 'secret');
    const tick = { op: 'tick', id: 'sinal', delta: 2 };
    const ticked = await service.notebook(agent('a'), tick, result.revision, 'tick');
    assert.deepEqual(ticked.clock, { value: 3, max: 4 });
    assert.equal((await service.notebook(agent('a'), tick, result.revision, 'tick')).repeated, true);
    await assert.rejects(service.notebook(agent('a'), tick, ticked.revision, 'overflow'), /Progresso final/);
    const state = await service.state(player('a'));
    assert.match(generalPrompt(state), /Porto/);
    assert.match(generalPrompt(state), /Sinal no farol 3\/4/);
    assert.doesNotMatch(generalPrompt(state), /O espião é a capitã/);
    assert.equal((await service.state(player('b'))).notes.length, 0);
    await service.undo(player('a'), ticked.history_id);
    assert.equal((await service.state(player('a'))).notes[0].clock.value, 1);
    assert.equal(journal(await service.state(player('a')))[0].actor, 'player');
});

test('registered tools use the Run target, cap responses, and validate operation envelopes', async () => {
    const { service } = fixture();
    const tools = new Map();
    await registerTools({ tools: { register: async (definition, callback) => tools.set(definition.name, { definition, callback }) } },
        { target: context => agent(context.target.chatRef.fileName, context.runId) }, service, () => true);
    const run = { runId: 'r', target: { kind: 'chat', chatRef: { fileName: 'a' } } };
    const lore = tools.get('mestre_lore');
    assert.deepEqual(lore.definition.contexts, ['chat']);
    assert.equal((await lore.callback({ view: 'books' }, run)).items[0].name, 'Costa');
    await assert.rejects(lore.callback({ view: 'entry', book: 'Costa' }, run), /Informe o UID/);
    await assert.rejects(lore.callback({ view: 'books', scope: 'global' }, run), /Campo desconhecido/);
    assert.equal((await lore.callback({ view: 'books' }, { ...run, target: { chatRef: { fileName: 'b' } } })).total, 0);
});

test('the bridge checks the stable chat identity and flushes the host writer before editing', async () => {
    const saved = {};
    let version = 'original';
    let flushed = false;
    const chat = {
        ref: { kind: 'character', characterId: 'gm', fileName: 'first' },
        stableId: async () => version,
        store: { listKeys: async () => [], setJson: async args => Object.assign(saved, args) },
    };
    const native = { flushWorldInfoSaves: async (_reason, names) => { flushed = names[0] === 'Costa'; } };
    const host = createHost({ chat: { open: () => chat, current: { handle: () => chat } } },
        () => ({ chatId: 'first', chatMetadata: { world_info: 'Costa' } }), async () => native);
    const binding = host.target({ target: { kind: 'chat', chatRef: chat.ref, stableChatId: 'original' }, runId: 'a' });
    assert.equal((await host.read(binding)).revision, 0);
    await host.write(binding, blankState());
    assert.equal(saved.namespace, 'mestre-agent');
    await host.flushBook('Costa');
    assert.equal(flushed, true);
    version = 'other';
    await assert.rejects(host.read(binding), /origem mudou/);
    assert.throws(() => host.target({ target: { kind: 'session' } }), /conversa/);
});
