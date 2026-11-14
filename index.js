import { ID, generalPrompt } from './data.js';
import { createHost } from './host.js';
import { createService } from './service.js';
import { createPanel } from './panel.js';
import { registerTools } from './tools.js';

let starting;

export function activate() {
    starting ??= start();
    return starting;
}

export async function disable() { (await starting)?.setEnabled(false); }
export async function enable() { (await activate())?.setEnabled(true); }

async function start() {
    const getContext = () => globalThis.SillyTavern.getContext();
    const shell = globalThis.__TAURITAVERN__;
    if (shell) await (shell.ready ?? globalThis.__TAURITAVERN_MAIN_READY__);
    const api = shell?.api;
    if (!api?.agent?.tools?.register || !api?.chat?.open) {
        globalThis.toastr?.warning('O Mestre usa o Agent Mode do TauriTavern 2.4.0.', 'Mestre');
        return null;
    }

    let enabled = true;
    let issue = '';
    let panel;
    let promptSequence = 0;
    const host = createHost(api, getContext);
    const { eventTypes, eventSource } = getContext();
    const setPrompt = value => getContext().setExtensionPrompt(ID, value, 1, 0, false);
    const service = createService(host, (binding, state) => {
        const visible = host.active();
        if (visible?.key !== binding.key || (binding.identity && visible.identity !== binding.identity)) return;
        ++promptSequence;
        try { setPrompt(enabled ? generalPrompt(state) : ''); }
        catch (error) { console.warn('[Mestre] Não foi possível atualizar o contexto.', error); }
        panel?.update(binding, state);
    });
    panel = createPanel({ host, service, getIssue: () => issue });

    async function prompt() {
        const sequence = ++promptSequence;
        const binding = enabled && host.active();
        if (!binding) { setPrompt(''); return; }
        try {
            const state = await service.state(binding);
            if (sequence === promptSequence && enabled && host.active()?.identity === binding.identity) setPrompt(generalPrompt(state));
        } catch {
            if (sequence === promptSequence) setPrompt('');
        }
    }

    async function worldInfo(batches) {
        const binding = enabled && host.active();
        if (!binding || !Array.isArray(batches?.chatLore)) return;
        try {
            const state = await service.state(binding);
            const names = new Set(host.names());
            const present = new Set(['globalLore', 'characterLore', 'chatLore', 'personaLore']
                .flatMap(source => Array.isArray(batches[source]) ? batches[source] : []).map(entry => entry.world));
            const extra = state.books.filter(book => book.include && book.access !== 'hidden' && names.has(book.name) && !present.has(book.name));
            const accepted = [];
            for (const book of extra) {
                try {
                    await host.flushBook(book.name);
                    const document = await host.readBook(book.name);
                    for (const [key, entry] of Object.entries(document.entries)) {
                        if (entry && typeof entry === 'object') accepted.push({ ...entry, uid: entry.uid ?? key, world: book.name });
                    }
                } catch (error) { console.warn('[Mestre] Não foi possível incluir ' + book.name + '.', error); }
            }
            if (!enabled || host.active()?.identity !== binding.identity) return;
            for (const entry of accepted) batches.chatLore.push(entry);
        } catch (error) { console.warn('[Mestre] Não foi possível consultar os vínculos da conversa.', error); }
    }

    function on(name, callback) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], callback);
    }
    on('CHAT_CHANGED', async () => {
        setPrompt('');
        panel.chatChanged();
        await prompt();
    });
    on('GENERATION_STARTED', async () => { setPrompt(''); await prompt(); });
    on('WORLDINFO_ENTRIES_LOADED', worldInfo);
    on('APP_READY', prompt);

    const runtime = {
        setEnabled(active) {
            enabled = active;
            panel.setEnabled(active);
            void prompt();
        },
    };
    try { await registerTools(api.agent, host, service, () => enabled); }
    catch (error) {
        console.error('[Mestre] Registro de ferramentas.', error);
        issue = 'O Agent não registrou todas as ferramentas. Consulte o console e recarregue o Tavern.';
        panel.refresh();
    }
    await prompt();
    return runtime;
}
