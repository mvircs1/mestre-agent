export const ID = 'mestre-agent';
export const NOTEBOOK_SIZE = 1_000_000;
export const KINDS = { fact: 'Fato', npc: 'NPC', thread: 'Trama', secret: 'Segredo', prep: 'Rascunho' };
export const STATUS = { open: 'Em aberto', resolved: 'Resolvida', archived: 'Arquivada' };
export const SCENE_FIELDS = {
    location: ['Local', 160],
    time: ['Quando', 160],
    cast: ['Presentes', 500],
    recap: ['O que já aconteceu', 2400],
    stakes: ['Em jogo agora', 1000],
};

export function requireValue(condition, message) {
    if (!condition) throw new Error(message);
}

export function record(value, label) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
        && [null, Object.prototype].includes(Object.getPrototypeOf(value)), label + ' deve ser um objeto.');
    return value;
}

export function fields(value, allowed, label) {
    record(value, label);
    for (const key of Object.keys(value)) requireValue(allowed.includes(key), 'Campo desconhecido em ' + label + ' · ' + key);
    return value;
}

export function text(value, max, label, { empty = false, trim = true } = {}) {
    requireValue(typeof value === 'string', label + ' deve ser texto.');
    const normalized = trim ? value.trim() : value;
    requireValue((empty || normalized.trim().length > 0) && normalized.length <= max, label + ' aceita até ' + max + ' caracteres.');
    return normalized;
}

export function integer(value, min, max, label) {
    requireValue(Number.isSafeInteger(value) && value >= min && value <= max, label + ' deve ser um inteiro entre ' + min + ' e ' + max + '.');
    return value;
}

export function bool(value, label) {
    requireValue(typeof value === 'boolean', label + ' deve ser verdadeiro ou falso.');
    return value;
}

export function oneOf(value, options, label) {
    requireValue(options.includes(value), label + ' aceita ' + options.join(', ') + '.');
    return value;
}

export function noteId(value) {
    requireValue(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
        && !['prototype', 'constructor'].includes(value), 'Use um ID de nota como encontro-na-ponte.');
    return value;
}

export function entryKey(value) {
    requireValue((typeof value === 'string' || Number.isSafeInteger(value)) && String(value).length > 0
        && String(value).length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(String(value)), 'ID de entrada inválido.');
    return String(value);
}

export function fold(value) {
    return String(value).normalize('NFC').toLowerCase();
}

export function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

export async function digest(value) {
    const bytes = new TextEncoder().encode(canonical(value));
    const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hashed, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function paginate(items, offset = 0, limit = 20) {
    const start = integer(offset, 0, 1_000_000, 'Offset');
    return { items: items.slice(start, start + limit), total: items.length, next_offset: start + limit < items.length ? start + limit : null };
}

export function excerpt(value, start = 0, size = 4500) {
    const from = integer(start, 0, 1_000_000, 'Início do texto');
    return { content: value.slice(from, from + size), next_start: from + size < value.length ? from + size : null, chars: value.length };
}

export function blankState() {
    return {
        version: 1, revision: 0, books: [], notes: [], history: [], pending: null,
        scene: Object.fromEntries(Object.keys(SCENE_FIELDS).map(key => [key, ''])),
    };
}

export function decodeState(value) {
    if (value === undefined || value === null) return blankState();
    record(value, 'Caderno salvo');
    requireValue(value.version === 1 && Array.isArray(value.books) && Array.isArray(value.notes) && Array.isArray(value.history)
        && value.books.length <= 200 && value.notes.length <= 200 && value.history.length <= 100, 'Formato de caderno incompatível.');
    integer(value.revision, 0, Number.MAX_SAFE_INTEGER, 'Revisão');
    return { ...structuredClone(value), scene: { ...blankState().scene, ...normalizeScene(value.scene, true) } };
}

export function bookAccess(state, name, nativeBook) {
    const entry = state.books.find(book => book.name === name);
    return entry?.access ?? (name === nativeBook ? 'write' : null);
}

function normalizeScene(patch, allowEmpty = false) {
    fields(patch, Object.keys(SCENE_FIELDS), 'Cena');
    requireValue(allowEmpty || Object.keys(patch).length, 'Informe um campo da cena.');
    return Object.fromEntries(Object.entries(patch).map(([key, value]) => [
        key, text(value, SCENE_FIELDS[key][1], SCENE_FIELDS[key][0], { empty: true }),
    ]));
}

function normalizeClock(value) {
    if (value === null) return null;
    fields(value, ['value', 'max'], 'Relógio');
    const max = integer(value.max, 1, 24, 'Tamanho do relógio');
    return { value: integer(value.value, 0, max, 'Progresso'), max };
}

export function editNotebook(state, command) {
    if (command.op === 'scene') {
        Object.assign(state.scene, normalizeScene(command.fields));
        return { label: 'Cena atualizada', result: { scene: state.scene } };
    }
    const id = noteId(command.id);
    const index = state.notes.findIndex(note => note.id === id);
    const previous = state.notes[index];
    if (command.op === 'remove') {
        requireValue(previous, 'Nota não encontrada.');
        state.notes.splice(index, 1);
        return { label: 'Nota removida · ' + previous.title, result: { id } };
    }
    if (command.op === 'tick') {
        requireValue(previous?.clock && previous.status !== 'archived', 'Crie um relógio em uma nota ativa antes de avançá-lo.');
        const delta = integer(command.delta, -24, 24, 'Avanço do relógio');
        previous.clock.value = integer(previous.clock.value + delta, 0, previous.clock.max, 'Progresso final');
        return { label: 'Relógio · ' + previous.title + ' · ' + previous.clock.value + '/' + previous.clock.max,
            result: { id, clock: previous.clock, reached: previous.clock.value === previous.clock.max } };
    }
    requireValue(command.op === 'note', 'Operação de caderno desconhecida.');
    const patch = fields(command.fields, ['title', 'kind', 'content', 'status', 'clock'], 'Nota');
    requireValue(Object.keys(patch).length, 'Informe um campo da nota.');
    const next = { ...{ id, title: '', kind: 'fact', content: '', status: 'open', clock: null }, ...previous, ...patch };
    next.title = text(next.title, 120, 'Título');
    next.kind = oneOf(next.kind, Object.keys(KINDS), 'Tipo de nota');
    next.content = text(next.content, 16_000, 'Conteúdo', { empty: true, trim: false });
    next.status = oneOf(next.status, Object.keys(STATUS), 'Estado da nota');
    next.clock = normalizeClock(next.clock);
    if (index < 0) {
        requireValue(state.notes.length < 200, 'O caderno chegou a 200 notas.');
        state.notes.push(next);
    } else state.notes[index] = next;
    return { label: (previous ? 'Nota editada · ' : 'Nota criada · ') + next.title, result: { id, title: next.title, kind: next.kind, status: next.status, clock: next.clock } };
}

export function generalPrompt(state) {
    const scene = Object.entries(state.scene).filter(([, value]) => value.trim()).map(([key, value]) => SCENE_FIELDS[key][0] + ' · ' + value);
    if (!scene.length && !state.notes.length && !state.books.length) return '';
    const openThreads = state.notes.filter(note => note.kind === 'thread' && note.status === 'open').slice(0, 8).map(note => {
        const clock = note.clock ? ' ' + note.clock.value + '/' + note.clock.max : '';
        return note.id + ' (' + note.title + clock + ')';
    });
    const prompt = [
        'Caderno Mestre desta conversa. Consulte mestre_context para ler a preparação e mestre_lore para consultar os livros da sessão.',
        'Atualize a cena e os fatos quando houver consequência em jogo. Use estados ou relógios para acompanhar tramas. Preserve a escolha da personagem do jogador.',
        'Use os segredos do caderno como informação do mestre e revele-os na ficção quando houver motivo.',
        ...scene, ...(openThreads.length ? ['Tramas em aberto · ' + openThreads.join(', ')] : []),
    ];
    return prompt.join('\n').slice(0, 3600).replaceAll('{{', '{ {');
}
