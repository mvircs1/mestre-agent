import { ID, KINDS, SCENE_FIELDS, STATUS, bookAccess, excerpt, fields, fold, oneOf, paginate, requireValue, text } from './data.js';
import { ENTRY_SCHEMA, listEntries } from './lore.js';

const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const enumOf = values => ({ type: 'string', enum: values });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const actionId = { type: 'string', maxLength: 80, description: 'Identificador único da operação nesta execução. Reuse ao repetir após uma falha.' };

function listNotes(state, arguments_) {
    const { kind, status, query = '', offset } = arguments_;
    if (kind !== undefined) oneOf(kind, Object.keys(KINDS), 'Tipo de nota');
    if (status !== undefined) oneOf(status, Object.keys(STATUS), 'Estado da nota');
    const needle = fold(text(query, 150, 'Busca', { empty: true }));
    return paginate(state.notes.filter(note => (!kind || kind === note.kind)
        && (status ? status === note.status : note.status !== 'archived')
        && (!needle || [note.id, note.title, note.content].some(value => fold(value).includes(needle))))
        .map(({ id, title, kind, status, clock, content }) => ({ id, title, kind, status, clock, chars: content.length, preview: content.slice(0, 220) })), offset);
}

function define(name, description, properties, required, run) {
    return { definition: { extensionId: ID, name: 'mestre_' + name, description,
        inputSchema: schema(properties, required), contexts: ['chat'] }, run };
}

export function definitions(service) {
    const noteFields = schema({
        title: string, kind: enumOf(Object.keys(KINDS)), content: string, status: enumOf(Object.keys(STATUS)),
        clock: nullable(schema({ value: integer, max: integer }, ['value', 'max'])),
    });
    const operations = schema({
        op: enumOf(['add', 'edit', 'remove']), uid: string, revision: string, fields: schema(ENTRY_SCHEMA),
    }, ['op']);
    return [
        define('context', 'Consulte a cena atual e as notas do caderno do mestre. Use view=scene no início da sessão, list para buscar fatos, NPCs, tramas, segredos e rascunhos e note para ler o texto por ID.', {
            view: enumOf(['scene', 'list', 'note']), id: string, query: string, offset: integer, start: integer,
            kind: enumOf(Object.keys(KINDS)), status: enumOf(Object.keys(STATUS)),
        }, ['view'], async (binding, args) => {
            const state = await service.state(binding);
            const revision = state.revision;
            if (args.view === 'list') return { revision, ...listNotes(state, args) };
            if (args.view === 'note') {
                const note = state.notes.find(note => note.id === args.id);
                requireValue(note, 'Nota não encontrada.');
                const { content, ...meta } = note;
                return { revision, ...meta, ...excerpt(content, args.start) };
            }
            requireValue(args.view === 'scene', 'Consulta de caderno desconhecida.');
            return {
                revision, scene: state.scene,
                threads: state.notes.filter(note => note.kind === 'thread' && note.status === 'open').slice(0, 16)
                    .map(({ id, title, clock }) => ({ id, title, clock })),
                notes: state.notes.length,
            };
        }),
        define('notebook', 'Atualize a memória da conversa. scene atualiza os campos da cena. note cria ou edita uma nota por ID, com tipo, conteúdo, estado e relógio opcional. tick avança ou recua um relógio. Leia a revisão atual com mestre_context. Registre fatos confirmados; mantenha ideias ainda não confirmadas em prep e revelações futuras em secret.', {
            op: enumOf(['scene', 'note', 'tick']), id: string, delta: integer, revision: integer, action_id: actionId,
            scene: schema(Object.fromEntries(Object.keys(SCENE_FIELDS).map(key => [key, string]))), note: noteFields,
        }, ['op', 'revision', 'action_id'], async (binding, args) => {
            oneOf(args.op, ['scene', 'note', 'tick'], 'Operação');
            const command = args.op === 'scene' ? { op: args.op, fields: args.scene }
                : args.op === 'note' ? { op: args.op, id: args.id, fields: args.note }
                    : { op: args.op, id: args.id, delta: args.delta };
            return service.notebook(binding, command, args.revision, args.action_id);
        }),
        define('lore', 'Consulte Lorebooks nativos da conversa. books lista livros acessíveis, inclusive o livro vinculado nativamente ao chat. entries busca entradas por nome, palavra-chave ou conteúdo. entry lê a entrada e devolve a revisão necessária para editar ou excluir.', {
            view: enumOf(['books', 'entries', 'entry']), book: string, uid: string, query: string, offset: integer, start: integer,
        }, ['view'], async (binding, args) => {
            if (args.view === 'books') {
                const state = await service.state(binding);
                const native = await service.nativeBook(binding);
                const books = state.books.filter(book => book.access !== 'hidden').map(({ name, access, include }) =>
                    ({ name, access, included: Boolean(include), native_book: name === native }));
                if (native && !state.books.some(book => book.name === native)) {
                    books.push({ name: native, access: bookAccess(state, native, native), included: false, native_book: true });
                }
                return paginate(books, args.offset);
            }
            if (args.view === 'entry') {
                requireValue(typeof args.uid === 'string', 'Informe o UID da entrada.');
                return service.inspect(binding, args.book, args.uid, { start: args.start });
            }
            requireValue(args.view === 'entries', 'Consulta de World Info desconhecida.');
            const { document } = await service.inspect(binding, args.book);
            return { book: args.book, ...listEntries(document, { query: args.query, offset: args.offset }) };
        }),
        define('create_book', 'Cria um Lorebook nativo novo para o mundo da conversa. Pode incluir até 10 entradas iniciais. Por padrão, acrescenta o livro ao contexto dessa conversa. Use um nome novo, título e conteúdo em cada entrada. Para publicação por palavras-chave, informe keywords.', {
            name: string, entries: { type: 'array', items: schema(ENTRY_SCHEMA, ['title', 'content']), maxItems: 10 },
            include_in_context: boolean, action_id: actionId,
        }, ['name', 'action_id'], (binding, args) => service.create(binding, args.name, args.action_id, args.entries, args.include_in_context)),
        define('edit_lore', 'Aplica de 1 a 10 mudanças no mesmo Lorebook nativo. add recebe fields com título e conteúdo. edit recebe UID e revisão de mestre_lore(entry) e altera só os campos informados. remove recebe UID e revisão. Uma exclusão de entrada fica restaurável no painel. Prefira enabled=false quando a entrada só precisar sair temporariamente da história.', {
            book: string, operations: { type: 'array', minItems: 1, maxItems: 10, items: operations }, action_id: actionId,
        }, ['book', 'operations', 'action_id'], (binding, args) => service.change(binding, args.book, args.operations, args.action_id)),
        define('use_book', 'Inclui ou retira um Lorebook com acesso de escrita do contexto extra do Mestre para esta conversa. Útil ao mudar de capítulo. O resultado indica se o vínculo nativo do chat continua ativo.', {
            book: string, included: boolean, action_id: actionId,
        }, ['book', 'included', 'action_id'], (binding, args) => service.link(binding, args.book, args.included, args.action_id)),
    ];
}

export async function registerTools(agent, host, service, isEnabled) {
    for (const { definition, run } of definitions(service)) {
        await agent.tools.register(definition, async (args, context) => {
            requireValue(isEnabled(), 'A extensão Mestre está desativada.');
            fields(args, Object.keys(definition.inputSchema.properties), 'Ferramenta do Mestre');
            for (const key of definition.inputSchema.required) requireValue(Object.hasOwn(args, key), 'Informe ' + key + '.');
            return { ok: true, ...await run(host.target(context), args) };
        });
    }
}
