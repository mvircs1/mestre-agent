import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const { chromium } = await import(process.env.MESTRE_PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
const files = new Set(['index.js', 'data.js', 'host.js', 'lore.js', 'service.js', 'tools.js', 'panel.js', 'style.css']);
const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const name = path === '/' ? 'test/fixtures/host.html' : path === '/scripts/world-info.js'
        ? 'test/fixtures/world-info.js' : files.has(path.slice(1)) ? path.slice(1) : null;
    if (!name) { response.writeHead(404).end(); return; }
    const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript';
    response.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    response.end(await readFile(new URL(name, root)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({ ...(process.env.MESTRE_CHROME ? { executablePath: process.env.MESTRE_CHROME } : {}) });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(7500);
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => globalThis.fixture?.definitions.size === 6);
    const press = (name, within = page) => within.getByRole('button', { name, exact: true }).click();
    const visible = locator => locator.waitFor({ state: 'visible' });
    const row = text => page.locator('.mestre-row').filter({ hasText: text });
    await press('Mestre');
    await press('Abrir', row('Costa'));
    await page.getByLabel('Acesso do Agent neste chat').selectOption('write');
    await page.getByLabel('Incluir no contexto deste chat').check();
    await press('Salvar acesso');
    await visible(page.getByText('Acesso atualizado.', { exact: true }));
    await press('Nova entrada');
    await page.getByLabel('Título', { exact: true }).fill('Farol');
    await page.getByLabel('Conteúdo', { exact: true }).fill('O farol está apagado.');
    await page.getByLabel('Palavras-chave', { exact: true }).fill('Farol');
    await press('Salvar');
    await visible(row('Farol'));
    const changed = await page.evaluate(async () => {
        const before = await fixture.tool('mestre_lore', { view: 'entry', book: 'Costa', uid: '1' });
        return fixture.tool('mestre_edit_lore', { book: 'Costa', action_id: 'apagar-farol', operations: [{
            op: 'edit', uid: '1', revision: before.revision, fields: { content: 'O farol reacendeu.' },
        }] });
    });
    assert.equal(changed.entries[0].title, 'Farol');
    assert.equal((await page.evaluate(() => fixture.books().Costa.entries[1].content)), 'O farol reacendeu.');
    await press('Histórico');
    await press('Desfazer', row('Entrada editada · Farol'));
    await press('Desfazer mudança');
    await visible(row('Restaurado · Entrada editada · Farol'));
    assert.equal((await page.evaluate(() => fixture.books().Costa.entries[1].content)), 'O farol está apagado.');
    await press('Caderno');
    await press('Editar cena');
    await page.getByLabel('Local', { exact: true }).fill('Cais');
    await page.getByLabel('Em jogo agora', { exact: true }).fill('Descobrir quem apagou o farol.');
    await press('Salvar');
    await visible(page.getByText('Em jogo · Descobrir quem apagou o farol.', { exact: true }));
    await press('Nova nota');
    await page.getByLabel('Título', { exact: true }).fill('Sinais da torre');
    await page.getByLabel('Tipo', { exact: true }).selectOption('thread');
    await page.getByLabel('Texto', { exact: true }).fill('A guarda vigia o cais.');
    await page.getByLabel('Tamanho do relógio', { exact: true }).fill('4');
    await page.getByLabel('Progresso', { exact: true }).fill('1');
    await press('Salvar');
    await visible(row('Sinais da torre'));
    const scans = await page.evaluate(async () => {
        await fixture.tool('mestre_create_book', { name: 'Ilha', action_id: 'ilha', entries: [
            { title: 'A trilha', content: 'Cuidado com a ponte.', mode: 'constant' },
        ] });
        const scan = await fixture.scan({ globalLore: [{ world: 'Costa', uid: 0 }], chatLore: [] });
        const other = await fixture.tool('mestre_context', { view: 'scene' }, 'b');
        return { scan, other };
    });
    assert.equal(scans.scan.chatLore.length, 1);
    assert.equal(scans.scan.chatLore[0].world, 'Ilha');
    assert.equal(scans.scan.globalLore[0].world, 'Costa');
    assert.equal(scans.other.notes, 0);
    await press('Chat B');
    await visible(page.getByText('Ainda sem notas.', { exact: true }));
    await press('Chat A');
    await visible(row('Sinais da torre'));
    await page.reload();
    await press('Mestre');
    await press('Caderno');
    await visible(row('Sinais da torre'));
    await page.setViewportSize({ width: 390, height: 680 });
    const bounds = await page.locator('#mestre-panel').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 680);
    if (process.env.MESTRE_SCREENSHOT) await page.screenshot({ path: process.env.MESTRE_SCREENSHOT });
    assert.deepEqual(errors, []);
    console.log('Smoke test passou no Chromium em desktop e celular.');
} catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) console.error(await page.locator('body').innerText().catch(() => ''));
    throw error;
} finally {
    await browser?.close();
    server.close();
}
