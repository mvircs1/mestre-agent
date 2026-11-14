import { KINDS, SCENE_FIELDS, STATUS, bookAccess, fold } from './data.js';
import { LOGIC, MODES, POSITIONS, ROLES, listEntries } from './lore.js';
import { journal } from './service.js';

const TABS = { lore: 'Lorebooks', notebook: 'Caderno', history: 'Histórico' };
const ACCESS = { hidden: 'Sem acesso', read: 'Pode ler', write: 'Pode editar' };

function element(tag, className, ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.append(...children.flat().filter(child => child !== null && child !== undefined));
    return node;
}

function button(label, action, { primary = false, submit = false, disabled = false } = {}) {
    const node = element('button', 'menu_button' + (primary ? ' mestre-primary' : ''), label);
    node.type = submit ? 'submit' : 'button';
    node.disabled = disabled;
    if (action) node.addEventListener('click', action);
    return node;
}

function input(value = '', options = {}) {
    return Object.assign(element('input', 'text_pole'), { type: 'text', ...options, value });
}

function textarea(value, maxLength, rows) {
    return Object.assign(element('textarea', 'text_pole'), { value, maxLength, rows });
}

function select(options, selected) {
    const control = element('select', 'text_pole');
    for (const [id, label] of Object.entries(options)) control.add(new Option(label, id));
    control.value = selected;
    return control;
}

function field(label, control) {
    control.setAttribute('aria-label', label);
    return element('label', 'mestre-field', element('span', null, label), control);
}

const heading = value => element('h3', null, value);
const muted = value => value ? element('small', 'mestre-muted', value) : null;
const grid = (...children) => element('div', 'mestre-grid', ...children);
const actions = (...children) => element('div', 'mestre-actions', ...children);
const paragraph = value => element('p', null, value);

function rows(items, empty) {
    return items.length ? element('div', 'mestre-list', ...items) : paragraph(empty);
}

function row(title, detail, ...buttons) {
    return element('div', 'mestre-row',
        element('div', 'mestre-row-text', element('strong', null, title), muted(detail)),
        buttons.length ? actions(...buttons) : null);
}

function idFromTitle(title) {
    return fold(title.normalize('NFD').replace(/\p{M}/gu, '')).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function bookEditor(current) {
    const title = input(current?.title ?? '', { required: true, maxLength: 100 });
    const content = textarea(current?.content ?? '', Math.max(24_000, current?.content.length ?? 0), 8);
    content.required = true;
    const keywords = textarea((current?.keywords ?? []).join('\n'), 7240, 2);
    keywords.placeholder = 'Uma chave por linha';
    const secondary = textarea((current?.secondary ?? []).join('\n'), 7240, 2);
    const mode = select(MODES, current?.mode ?? 'keywords');
    const enabled = input('', { type: 'checkbox', checked: current?.enabled ?? true });
    const position = select(POSITIONS, current?.position ?? 'before');
    const logic = select(LOGIC, current?.logic ?? 'any');
    const role = select(ROLES, current?.role ?? 'system');
    const outlet = input(current?.outlet ?? '', { maxLength: 100 });
    const depth = input(current?.depth ?? 4, { type: 'number', min: 0, max: 1000, required: true });
    const order = input(current?.order ?? 100, { type: 'number', required: true });
    const probability = input(current?.probability ?? '', { type: 'number', min: 0, max: 100, placeholder: 'Sempre' });
    const lines = control => control.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const fields = [
        field('Título', title), field('Conteúdo', content), field('Palavras-chave', keywords),
        grid(field('Ativação', mode), field('Ativada', enabled)),
        element('details', null, element('summary', null, 'Outras opções'),
            field('Chaves secundárias', secondary), field('Filtro das chaves secundárias', logic), field('Posição', position),
            grid(field('Profundidade', depth), field('Papel', role), field('Ordem', order)),
            grid(field('Probabilidade (%)', probability), field('Nome do outlet', outlet))),
    ];
    return {
        fields,
        value() {
            const patch = {
                title: title.value, content: content.value, keywords: lines(keywords), secondary: lines(secondary),
                mode: mode.value, enabled: enabled.checked, position: position.value, logic: logic.value, role: role.value,
                outlet: outlet.value, depth: Number(depth.value), order: Number(order.value),
                probability: probability.value === '' ? null : Number(probability.value),
            };
            if (!current) return { ...patch, enabled: patch.enabled && (patch.mode !== 'keywords' || patch.keywords.length > 0) };
            return Object.fromEntries(Object.entries(patch).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key])));
        },
    };
}

export function createPanel({ host, service, getIssue }) {
    const launch = button('Mestre');
    launch.className = 'mestre-launch interactable';
    launch.setAttribute('aria-controls', 'mestre-panel');
    launch.setAttribute('aria-expanded', 'false');
    const title = element('h2', null, 'Mestre');
    title.id = 'mestre-title';
    const tabs = element('nav', 'mestre-tabs');
    tabs.setAttribute('aria-label', 'Mestre');
    const notice = element('p', 'mestre-status');
    notice.setAttribute('role', 'status');
    notice.hidden = true;
    const body = element('div', 'mestre-body');
    const closeButton = button('Fechar', close);
    const panel = element('aside', 'mestre-panel', element('header', null, title, closeButton), tabs, notice, body);
    panel.id = 'mestre-panel';
    panel.hidden = true;
    panel.setAttribute('aria-labelledby', title.id);
    document.body.append(panel);
    const composer = document.querySelector('#leftSendForm') ?? document.querySelector('#extensions_settings');
    if (!composer) launch.classList.add('mestre-fallback');
    (composer ?? document.body).append(launch);

    let active;
    let state;
    let tab = 'lore';
    let view = null;
    let generation = 0;
    let busy = false;

    function status(message = '', error = false) {
        notice.textContent = message || getIssue();
        notice.classList.toggle('mestre-error', Boolean(error || (!message && getIssue())));
        notice.hidden = !notice.textContent;
    }

    function change(next = null) {
        if (busy) return;
        view = next;
        status();
        render();
        if (next) body.querySelector('input:not([type=checkbox]), textarea, select')?.focus();
    }

    function close() {
        panel.hidden = true;
        launch.setAttribute('aria-expanded', 'false');
        launch.focus();
    }

    function open() {
        panel.hidden = false;
        launch.setAttribute('aria-expanded', 'true');
        reload(true);
        closeButton.focus();
    }
    launch.addEventListener('click', () => panel.hidden ? open() : close());
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); }
    });

    async function reload(reset = false) {
        const id = ++generation;
        active = host.active();
        if (reset) view = null;
        state = null;
        if (!active) { render(); return; }
        const binding = active;
        status();
        render();
        try {
            const data = await service.state(binding);
            if (generation !== id) return;
            state = data;
            render();
        } catch (error) {
            if (generation !== id) return;
            status(error.message, true);
            body.replaceChildren(button('Tentar novamente', () => reload(true)));
        }
    }

    async function perform(action, after, form) {
        if (busy) return;
        const binding = active;
        if (!binding) return;
        const id = generation;
        busy = true;
        panel.setAttribute('aria-busy', 'true');
        status();
        if (form) for (const button of form.querySelectorAll('button')) button.disabled = true;
        let result;
        try { result = await action(binding); }
        catch (error) {
            if (generation === id) status(error?.message ?? String(error), true);
            return;
        } finally {
            busy = false;
            panel.removeAttribute('aria-busy');
            if (form) for (const button of form.querySelectorAll('button')) button.disabled = false;
        }
        if (generation !== id) return;
        try {
            if (after) await after(result);
            else await reload();
        } catch (error) {
            if (generation === id) status(error?.message ?? String(error), true);
        }
    }

    function form(children, apply, { label = 'Salvar', extra = [], back = null } = {}) {
        const node = element('form', 'mestre-form', ...children,
            actions(button(label, null, { primary: true, submit: true }), button('Voltar', back ?? (() => change())), ...extra));
        node.addEventListener('submit', event => {
            event.preventDefault();
            apply(node);
        });
        return node;
    }

    function historyView() {
        const entries = journal(state);
        const pending = state.pending;
        return [
            pending ? element('section', 'mestre-block', heading('Gravação pendente'), paragraph(pending.label),
                actions(button('Conferir gravação', () => perform(binding => service.checkPending(binding))),
                    button('Liberar histórico', () => change({ type: 'pending', item: pending })))) : null,
            rows(entries.map(item => row(item.label, [item.book, item.actor === 'agent' ? 'Agent' : 'Jogador',
                new Date(item.at).toLocaleString('pt-BR'), item.undoneAt ? 'Restaurado' : ''].filter(Boolean).join(' · '),
            ...(item.undoable ? [button('Desfazer', () => change({ type: 'undo', item }))] : []))), 'As mudanças desta conversa aparecem aqui.'),
        ];
    }

    function bookList() {
        const search = input('', { type: 'search', placeholder: 'Buscar Lorebook' });
        const list = element('div');
        const native = active.nativeBook;
        const books = host.names();
        const update = () => {
            const needle = fold(search.value.trim());
            const showing = books.filter(name => !needle || fold(name).includes(needle));
            list.replaceChildren(rows(showing.map(name => {
                const link = state.books.find(book => book.name === name);
                const access = bookAccess(state, name, native) || 'hidden';
                const role = [ACCESS[access], name === native ? 'Vínculo nativo' : '', link?.include ? 'Incluído pelo Mestre' : ''].filter(Boolean).join(' · ');
                return row(name, role, button('Abrir', () => openBook(name)));
            }), 'Nenhum Lorebook encontrado.'));
        };
        update();
        search.addEventListener('input', update);
        return [actions(button('Novo Lorebook', () => change({ type: 'new-book' }), { primary: true })), field('Buscar Lorebook', search), list];
    }

    function openBook(name) {
        return perform(binding => service.inspect(binding, name), result => change({ type: 'book', ...result }));
    }

    function openEntry(book, uid) {
        return perform(binding => service.inspect(binding, book, uid, { full: true }), result => change({ type: 'entry', book, entry: result }));
    }

    function bookView() {
        const { name, document } = view;
        const link = state.books.find(book => book.name === name);
        const access = select(ACCESS, bookAccess(state, name, active.nativeBook) || 'hidden');
        const included = input('', { type: 'checkbox', checked: Boolean(link?.include), disabled: access.value === 'hidden' });
        const accessForm = element('form', 'mestre-form',
            grid(field('Acesso do Agent neste chat', access), field('Incluir no contexto deste chat', included)),
            actions(button('Salvar acesso', null, { submit: true })));
        access.addEventListener('change', () => {
            included.disabled = access.value === 'hidden';
            if (included.disabled) included.checked = false;
        });
        accessForm.addEventListener('submit', event => {
            event.preventDefault();
            perform(binding => service.access(binding, name, access.value, included.checked), result => {
                state = result;
                render();
                status('Acesso atualizado.');
            }, accessForm);
        });
        const search = input('', { type: 'search', maxLength: 150, placeholder: 'Título, chave ou conteúdo' });
        const list = element('div');
        let offset = 0;
        function update() {
            const page = listEntries(document, { query: search.value, offset });
            list.replaceChildren(rows(page.items.map(item => row(item.title, '#' + item.uid + ' · ' + (item.enabled ? MODES[item.mode] : 'Desativada'),
                button('Editar', () => openEntry(name, item.uid)))), 'Nenhuma entrada encontrada.'));
            if (offset || page.next_offset !== null) list.append(actions(
                offset ? button('Anterior', () => { offset -= 20; update(); }) : null,
                page.next_offset !== null ? button('Próxima', () => { offset = page.next_offset; update(); }) : null));
        }
        search.addEventListener('input', () => { offset = 0; update(); });
        update();
        return [
            actions(button('Todos os livros', () => change()), button('Nova entrada', () => change({ type: 'entry', book: name }), { primary: true })),
            heading(name),
            accessForm,
            field('Buscar entradas', search), list,
        ];
    }

    function newBook() {
        const name = input('', { required: true, maxLength: 100 });
        const include = input('', { type: 'checkbox', checked: true });
        return form([heading('Novo Lorebook nativo'), field('Nome', name), field('Incluir no contexto deste chat', include)],
            form => perform(binding => service.create(binding, name.value, undefined, [], include.checked), async result => {
                state = await service.state(active);
                await openBook(result.book);
            }, form), { label: 'Criar Lorebook' });
    }

    function entryForm() {
        const { book, entry } = view;
        const editor = bookEditor(entry);
        const extra = entry ? [
            button('Abrir no World Info', () => perform(() => host.openEntry(book, entry.uid), close)),
            button('Excluir', () => change({ type: 'delete-entry', book, entry })),
        ] : [];
        return form([heading(book), muted(entry ? 'Entrada #' + entry.uid : 'Nova entrada'), ...editor.fields], node => {
            const patch = editor.value();
            if (!Object.keys(patch).length) { void openBook(book); return; }
            const operation = entry ? { op: 'edit', uid: entry.uid, revision: entry.revision, fields: patch } : { op: 'add', fields: patch };
            perform(binding => service.change(binding, book, [operation]), async () => {
                state = await service.state(active);
                await openBook(book);
                status('Entrada salva no World Info.');
            }, node);
        }, { back: () => openBook(book), extra });
    }

    function notebookView() {
        const search = input('', { type: 'search', placeholder: 'Buscar notas' });
        const filters = select({ all: 'Todas', ...KINDS }, 'all');
        const list = element('div');
        function update() {
            const query = fold(search.value.trim());
            const found = state.notes.filter(note => (filters.value === 'all' || filters.value === note.kind)
                && (!query || fold(note.title + '\n' + note.content).includes(query)));
            list.replaceChildren(rows(found.map(note => {
                const progress = note.clock ? note.clock.value + '/' + note.clock.max : '';
                return row(note.title, [KINDS[note.kind], STATUS[note.status], progress].filter(Boolean).join(' · '),
                    button('Editar', () => change({ type: 'note', note, revision: state.revision })));
            }), 'Ainda sem notas.'));
        }
        search.addEventListener('input', update);
        filters.addEventListener('change', update);
        update();
        const sceneText = [state.scene.location, state.scene.time].filter(Boolean).join(' · ');
        return [
            element('section', 'mestre-block', heading('Cena atual'), muted(sceneText),
                state.scene.cast ? paragraph('Presentes · ' + state.scene.cast) : null,
                state.scene.recap ? paragraph(state.scene.recap) : null,
                state.scene.stakes ? paragraph('Em jogo · ' + state.scene.stakes) : null,
                button('Editar cena', () => change({ type: 'scene', revision: state.revision }))),
            actions(button('Nova nota', () => change({ type: 'note', revision: state.revision }), { primary: true })),
            grid(field('Buscar notas', search), field('Filtrar por tipo', filters)), list,
        ];
    }

    function sceneForm() {
        const revision = view.revision;
        const controls = Object.entries(SCENE_FIELDS).map(([key, [label, max]]) =>
            [key, label, max > 180 ? textarea(state.scene[key], max, key === 'recap' ? 5 : 2) : input(state.scene[key], { maxLength: max })]);
        return form([heading('Editar cena'), ...controls.map(([, label, control]) => field(label, control))],
            node => perform(binding => service.notebook(binding, {
                op: 'scene', fields: Object.fromEntries(controls.map(([key, , control]) => [key, control.value])),
            }, revision), () => reload(true), node));
    }

    function noteForm() {
        const { note, revision } = view;
        const title = input(note?.title ?? '', { maxLength: 120, required: true });
        const kind = select(KINDS, note?.kind ?? 'fact');
        const state = select(STATUS, note?.status ?? 'open');
        const content = textarea(note?.content ?? '', 16_000, 8);
        const max = input(note?.clock?.max ?? '', { type: 'number', min: 1, max: 24, placeholder: 'Sem relógio' });
        const value = input(note?.clock?.value ?? '', { type: 'number', min: 0, max: 24 });
        return form([heading(note ? 'Editar nota' : 'Nova nota'), field('Título', title), grid(field('Tipo', kind), field('Estado', state)),
            field('Texto', content), grid(field('Tamanho do relógio', max), field('Progresso', value))],
        node => perform(binding => service.notebook(binding, {
            op: 'note', id: note?.id ?? (idFromTitle(title.value) || 'nota') + '-' + crypto.randomUUID().slice(0, 6),
            fields: { title: title.value, kind: kind.value, status: state.value, content: content.value,
                clock: max.value === '' ? null : { value: Number(value.value), max: Number(max.value) } },
        }, revision), () => reload(true), node), {
            extra: note ? [button('Excluir nota', () => change({ type: 'delete-note', note, revision }))] : [],
        });
    }

    function confirmation() {
        const current = view;
        const name = current.entry?.title ?? current.note?.title ?? current.item?.label;
        const undo = current.type === 'undo';
        const label = undo ? 'Desfazer mudança' : 'Excluir';
        return form([heading(label), paragraph(name)], node => perform(binding => {
            if (undo) return service.undo(binding, current.item.id);
            if (current.entry) return service.change(binding, current.book, [{ op: 'remove', uid: current.entry.uid, revision: current.entry.revision }]);
            return service.notebook(binding, { op: 'remove', id: current.note.id }, current.revision);
        }, async () => {
            if (!current.book) return reload(true);
            state = await service.state(active);
            return openBook(current.book);
        }, node), { label, back: current.book ? () => openBook(current.book) : null });
    }

    function pendingForm() {
        const { item } = view;
        return form([heading('Conferir gravação'), paragraph(item.label),
            paragraph('Confira o resultado no editor do World Info. Se o livro tiver sido alterado depois, o botão abaixo libera o histórico para novas edições.')],
        node => perform(binding => service.clearPending(binding), () => reload(true), node), { label: 'Conferir e liberar' });
    }

    function render() {
        if (panel.hidden) return;
        tabs.replaceChildren(...Object.entries(TABS).map(([key, label]) => {
            const control = button(label, () => { if (!busy) { tab = key; change(); } });
            control.setAttribute('aria-pressed', String(key === tab));
            return control;
        }));
        if (!active || !state) {
            body.replaceChildren(paragraph(active ? 'Carregando…' : 'Abra uma conversa salva.'));
            return;
        }
        const views = { book: bookView, 'new-book': newBook, entry: entryForm, note: noteForm, scene: sceneForm,
            'delete-entry': confirmation, 'delete-note': confirmation, undo: confirmation, pending: pendingForm };
        const collection = { lore: bookList, notebook: notebookView, history: historyView };
        const content = view ? views[view.type]() : collection[tab]();
        body.replaceChildren(...[content].flat().filter(Boolean));
    }

    return {
        setEnabled(enabled) {
            if (!enabled && !panel.hidden) close();
            launch.hidden = !enabled;
        },
        chatChanged() { if (!panel.hidden) reload(true); },
        refresh() { if (!panel.hidden) status(); },
        update(binding, updated) {
            if (!active || binding.key !== active.key || panel.hidden) return;
            state = updated;
            if (busy) return;
            if (!view) render();
            else if (view.entry || view.note || view.type === 'scene') status('O Agent atualizou o Mestre. O editor verificará se sua revisão ainda é válida.');
        },
    };
}
