import { bool, canonical, entryKey, excerpt, fields, fold, integer, oneOf, paginate, record, requireValue, text } from './data.js';

export const MODES = { keywords: 'Palavras-chave', constant: 'Sempre ativa', vector: 'Vetorial' };
export const POSITIONS = {
    before: 'Antes da descrição', after: 'Depois da descrição', note_top: 'Antes da nota do autor',
    note_bottom: 'Depois da nota do autor', depth: 'Em profundidade no chat',
    example_top: 'Antes dos exemplos', example_bottom: 'Depois dos exemplos', outlet: 'Outlet',
};
export const LOGIC = { any: 'Qualquer chave secundária', not_all: 'Nem todas as secundárias', none: 'Nenhuma secundária', all: 'Todas as secundárias' };
export const ROLES = { system: 'Sistema', user: 'Usuário', assistant: 'Assistente' };

const positions = Object.keys(POSITIONS);
const logic = Object.keys(LOGIC);
const roles = Object.keys(ROLES);
const string = { type: 'string' };
const strings = { type: 'array', items: string, maxItems: 40 };
const boolean = { type: 'boolean' };
const number = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const enumeration = options => ({ type: 'string', enum: options });

export const ENTRY_FIELDS = {
    title: { schema: { ...string, maxLength: 100 }, key: 'comment', mirror: 'comment', parse: value => text(value, 100, 'Título') },
    content: { schema: { ...string, maxLength: 24_000 }, key: 'content', mirror: 'content', parse: value => text(value, 24_000, 'Conteúdo', { trim: false }) },
    keywords: { schema: strings, key: 'key', mirror: 'keys', parse: value => keywords(value) },
    secondary: { schema: strings, key: 'keysecondary', mirror: 'secondary_keys', parse: value => keywords(value) },
    logic: { schema: enumeration(logic), key: 'selectiveLogic', mirror: 'selectiveLogic', parse: value => logic.indexOf(oneOf(value, logic, 'Filtro secundário')) },
    enabled: { schema: boolean, key: 'disable', mirror: 'enabled', parse: value => !bool(value, 'Ativada'), mirrorValue: value => !value },
    order: { schema: number(-100_000, 100_000), key: 'order', mirror: 'insertion_order', parse: value => integer(value, -100_000, 100_000, 'Ordem') },
    position: { schema: enumeration(positions), key: 'position', mirror: 'extensions.position', parse: value => positions.indexOf(oneOf(value, positions, 'Posição')) },
    depth: { schema: number(0, 1000), key: 'depth', mirror: 'extensions.depth', parse: value => integer(value, 0, 1000, 'Profundidade') },
    role: { schema: enumeration(roles), key: 'role', mirror: 'extensions.role', parse: value => roles.indexOf(oneOf(value, roles, 'Papel')) },
    outlet: { schema: { ...string, maxLength: 100 }, key: 'outletName', mirror: 'extensions.outlet_name',
        parse: value => text(value, 100, 'Outlet', { empty: true }) },
    probability: { schema: nullable(number(0, 100)), key: 'probability', mirror: 'extensions.probability',
        parse: value => value === null ? 100 : integer(value, 0, 100, 'Probabilidade') },
    sticky: { schema: nullable(number(0, 1000)), key: 'sticky', mirror: 'extensions.sticky', parse: value => timer(value, 'Permanência') },
    cooldown: { schema: nullable(number(0, 1000)), key: 'cooldown', mirror: 'extensions.cooldown', parse: value => timer(value, 'Recarga') },
    delay: { schema: nullable(number(0, 1000)), key: 'delay', mirror: 'extensions.delay', parse: value => timer(value, 'Atraso') },
};

export const ENTRY_SCHEMA = Object.fromEntries([...Object.entries(ENTRY_FIELDS).map(([key, field]) => [key, field.schema]),
    ['mode', enumeration(Object.keys(MODES))]]);

function keywords(value) {
    requireValue(Array.isArray(value) && value.length <= 40, 'Use uma lista de até 40 chaves.');
    return [...new Set(value.map(word => text(word, 180, 'Chave')))];
}

function timer(value, label) {
    return value === null ? null : integer(value, 0, 1000, label);
}

function entry(document, uid) {
    const key = entryKey(uid);
    const value = Object.hasOwn(document.entries, key) ? document.entries[key] : undefined;
    requireValue(value, 'Entrada ' + key + ' não encontrada.');
    return record(value, 'Entrada');
}

export function summary(uid, raw) {
    return { uid: String(uid), title: String(raw.comment || raw.key?.[0] || 'Entrada ' + uid),
        enabled: !raw.disable, mode: raw.constant ? 'constant' : raw.vectorized ? 'vector' : 'keywords',
        keywords: Array.isArray(raw.key) ? raw.key : [] };
}

export function listEntries(document, { query = '', offset = 0 } = {}) {
    const needle = fold(text(query, 150, 'Busca', { empty: true }));
    const matching = Object.entries(document.entries).filter(([, value]) => value && typeof value === 'object')
        .map(([uid, raw]) => ({ item: summary(uid, raw), raw }))
        .filter(({ item, raw }) => !needle || [item.uid, item.title, ...item.keywords, raw.content].some(value => fold(value ?? '').includes(needle)))
        .map(({ item }) => item);
    return paginate(matching, offset);
}

export function readEntry(document, uid, { start = 0, full = false } = {}) {
    const raw = entry(document, uid);
    const meta = summary(uid, raw);
    const content = String(raw.content ?? '');
    const result = {
        ...meta,
        secondary: Array.isArray(raw.keysecondary) ? raw.keysecondary : [],
        logic: logic[raw.selectiveLogic] ?? 'any',
        order: raw.order ?? 100, position: positions[raw.position] ?? 'before', depth: raw.depth ?? 4, role: roles[raw.role] ?? 'system',
        outlet: raw.outletName ?? '', probability: raw.useProbability === false ? null : raw.probability ?? 100,
        sticky: raw.sticky ?? null, cooldown: raw.cooldown ?? null, delay: raw.delay ?? null,
        ...excerpt(content, start, full ? Number.MAX_SAFE_INTEGER : 4500),
    };
    if (full) result.raw = raw;
    return result;
}

function backReference(document, key) {
    const original = document.originalData?.entries;
    if (!Array.isArray(original)) return undefined;
    return original.find(item => item && (String(item.uid ?? '') === key || String(item.id ?? '') === key));
}

function mirrorValue(original, path, value) {
    if (!original) return;
    const [first, second] = path.split('.');
    if (second) original[first] = { ...original[first], [second]: structuredClone(value) };
    else original[first] = structuredClone(value);
}

function applyFields(raw, patch, original, { created = false } = {}) {
    fields(patch, Object.keys(ENTRY_SCHEMA), 'Entrada de World Info');
    requireValue(Object.keys(patch).length, 'Informe ao menos um campo da entrada.');
    if (Object.hasOwn(patch, 'mode')) {
        const mode = oneOf(patch.mode, Object.keys(MODES), 'Modo');
        raw.constant = mode === 'constant';
        raw.vectorized = mode === 'vector';
        mirrorValue(original, 'constant', raw.constant);
        mirrorValue(original, 'extensions.vectorized', raw.vectorized);
    }
    for (const [field, value] of Object.entries(patch)) {
        if (field === 'mode') continue;
        const definition = ENTRY_FIELDS[field];
        const normalized = definition.parse(value);
        raw[definition.key] = normalized;
        const mirror = definition.mirrorValue ? definition.mirrorValue(normalized) : normalized;
        mirrorValue(original, definition.mirror, mirror);
    }
    if (Object.hasOwn(patch, 'title')) raw.addMemo = true;
    if (Object.hasOwn(patch, 'secondary')) {
        raw.selective = raw.keysecondary.length > 0;
        mirrorValue(original, 'selective', raw.selective);
    }
    if (Object.hasOwn(patch, 'probability')) {
        raw.useProbability = patch.probability !== null;
        mirrorValue(original, 'extensions.useProbability', raw.useProbability);
    }
    if (Object.hasOwn(patch, 'position')) mirrorValue(original, 'position', raw.position === 0 ? 'before_char' : 'after_char');
    if (created || Object.hasOwn(patch, 'position') || Object.hasOwn(patch, 'outlet')) {
        requireValue(raw.position !== 7 || (typeof raw.outletName === 'string' && raw.outletName.trim()), 'Informe o nome do outlet para essa posição.');
    }
}

function newOriginal(document, raw) {
    if (!Array.isArray(document.originalData?.entries)) return undefined;
    const original = {
        id: raw.uid, keys: [], secondary_keys: [], content: '', enabled: true, insertion_order: raw.order ?? 100,
        position: raw.position === 0 ? 'before_char' : 'after_char', extensions: {},
    };
    document.originalData.entries.push(original);
    return original;
}

export function snapshot(document, uid) {
    const key = entryKey(uid);
    return { raw: structuredClone(document.entries[key] ?? null), original: structuredClone(backReference(document, key) ?? null) };
}

export function restoreEntries(document, changes) {
    for (const change of changes) {
        requireValue(canonical(snapshot(document, change.uid)) === canonical(change.after),
            'A entrada ' + change.uid + ' mudou depois desta operação. Confira o editor antes de restaurar.');
    }
    for (const { uid, before } of changes) {
        if (before.raw === null) delete document.entries[uid];
        else document.entries[uid] = structuredClone(before.raw);
        if (Array.isArray(document.originalData?.entries)) {
            const originals = document.originalData.entries;
            const index = originals.indexOf(backReference(document, uid));
            if (index >= 0 && before.original) originals[index] = structuredClone(before.original);
            else if (index >= 0) originals.splice(index, 1);
            else if (before.original) originals.push(structuredClone(before.original));
        }
    }
}

export async function changeEntries(name, document, operations, revision, createEntry) {
    requireValue(Array.isArray(operations) && operations.length >= 1 && operations.length <= 10, 'Envie de 1 a 10 operações.');
    const changes = [];
    const result = [];
    const seen = new Set();
    const ordered = [...operations.filter(item => item?.op === 'add'), ...operations.filter(item => item?.op !== 'add')];
    for (const operation of ordered) {
        fields(operation, ['op', 'uid', 'fields', 'revision'], 'Operação do Lorebook');
        const kind = oneOf(operation.op, ['add', 'edit', 'remove'], 'Operação');
        if (kind === 'add') {
            requireValue(operation.uid === undefined && operation.revision === undefined, 'Uma nova entrada recebe seu UID do Tavern.');
            const patch = record(operation.fields, 'Nova entrada');
            requireValue(Object.hasOwn(patch, 'title') && Object.hasOwn(patch, 'content'), 'Preencha título e conteúdo da nova entrada.');
            const raw = await createEntry(name, document);
            const uid = entryKey(raw.uid);
            const original = newOriginal(document, raw);
            applyFields(raw, patch, original, { created: true });
            if (!raw.constant && !raw.vectorized && !raw.key?.length && !Object.hasOwn(patch, 'enabled')) {
                raw.disable = true;
                mirrorValue(original, 'enabled', false);
            }
            seen.add(uid);
            changes.push({ uid, before: { raw: null, original: null }, after: snapshot(document, uid) });
            result.push({ ...summary(uid, raw), op: kind });
            continue;
        }
        const uid = entryKey(operation.uid);
        requireValue(!seen.has(uid), 'Cada entrada pode aparecer uma vez no lote.');
        seen.add(uid);
        const raw = entry(document, uid);
        const before = snapshot(document, uid);
        requireValue(operation.revision === await revision(before), 'A entrada ' + uid + ' mudou. Leia a revisão atual e tente novamente.');
        const original = backReference(document, uid);
        if (kind === 'edit') applyFields(raw, operation.fields, original);
        else {
            requireValue(operation.fields === undefined, 'Uma exclusão usa apenas UID e revisão.');
            if (original) document.originalData.entries.splice(document.originalData.entries.indexOf(original), 1);
            delete document.entries[uid];
        }
        changes.push({ uid, before, after: snapshot(document, uid) });
        result.push({ ...summary(uid, raw), op: kind });
    }
    return { changes, result };
}
