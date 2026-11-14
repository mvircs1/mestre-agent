import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const { chromium } = await import(process.env.MESTRE_PLAYWRIGHT_MODULE || 'playwright');
assert.ok(process.env.MESTRE_NATIVE_DIR && process.env.MESTRE_NATIVE_PORT, 'Informe a pasta e porta da cópia portátil descartável do teste.');
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.MESTRE_NATIVE_PORT);
const page = browser.contexts()[0].pages()[0];
try {
    page.setDefaultTimeout(12_000);
    const manifestList = await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        if (!context.chatId) await context.selectCharacterById(0);
        const { tools } = await window.__TAURITAVERN__.api.agent.tools.list({ context: 'chat' });
        return tools.filter(tool => tool.id.startsWith('extension/mestre-agent:')).map(tool => tool.id);
    });
    assert.equal(manifestList.length, 6);
    const press = (name, target = page) => target.getByRole('button', { name, exact: true }).click();
    const visible = locator => locator.waitFor({ state: 'visible' });
    const row = value => page.locator('.mestre-row').filter({ hasText: value });
    const book = 'Mestre teste ' + Date.now();
    await press('Mestre');
    await press('Novo Lorebook');
    await page.getByLabel('Nome', { exact: true }).fill(book);
    await press('Criar Lorebook');
    await visible(page.getByRole('heading', { name: book }));
    await press('Nova entrada');
    await page.getByLabel('Título', { exact: true }).fill('O farol de prova');
    await page.getByLabel('Conteúdo', { exact: true }).fill('A luz piscou duas vezes.');
    await page.getByLabel('Palavras-chave', { exact: true }).fill('Farol');
    await press('Salvar');
    await visible(row('O farol de prova'));
    const path = join(process.env.MESTRE_NATIVE_DIR, 'data', 'default-user', 'worlds', book + '.json');
    const first = JSON.parse(await readFile(path, 'utf-8'));
    assert.equal(first.entries[0].content, 'A luz piscou duas vezes.');
    await press('Editar', row('O farol de prova'));
    await page.getByLabel('Conteúdo', { exact: true }).fill('A luz agora está apagada.');
    await press('Salvar');
    await visible(row('O farol de prova'));
    assert.equal(JSON.parse(await readFile(path, 'utf-8')).entries[0].content, 'A luz agora está apagada.');
    await press('Histórico');
    await press('Desfazer', row('Entrada editada · O farol de prova').filter({ hasText: book }));
    await press('Desfazer mudança');
    await visible(row('Restaurado · Entrada editada · O farol de prova').filter({ hasText: book }));
    assert.equal(JSON.parse(await readFile(path, 'utf-8')).entries[0].content, 'A luz piscou duas vezes.');
    await page.reload();
    await visible(page.getByRole('button', { name: 'Mestre', exact: true }));
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        if (!context.chatId) await context.selectCharacterById(0);
    });
    await press('Mestre');
    await press('Abrir', row(book));
    await visible(row('O farol de prova'));
    const included = await page.evaluate(async book => {
        const world = await import('/scripts/world-info.js');
        return (await world.getSortedEntries()).some(entry => entry.world === book && entry.content === 'A luz piscou duas vezes.');
    }, book);
    assert.equal(included, true);
    console.log('TauriTavern 2.4.0 · seis ferramentas registradas, World Info nativo criado, editado, restaurado e incluído no contexto após recarga.');
    process.exit(0);
} catch (error) {
    console.error(await page.locator('#mestre-panel').innerText().catch(() => ''));
    console.error(error);
    process.exit(1);
}
