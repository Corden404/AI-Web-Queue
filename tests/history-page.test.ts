import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import type { HistoryRequest } from '../src/core/history.ts';

const built = await build({ configFile: false, logLevel: 'silent', build: { write: false,
  target: 'chrome120', lib: { entry: 'src/history-page.ts', formats: ['iife'], name: 'HistoryPageTest' } } });
const output = Array.isArray(built) ? built[0] : built;
if (!('output' in output)) throw new Error('Expected a history-page bundle');
const code = output.output.find(part => part.type === 'chunk')!.code;
const html = await readFile('public/history.html', 'utf8');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

test('history page exposes capacity, recoverable cleanup, restore, and complete JSON export', async () => {
  const dom = new JSDOM(html, { url: 'https://extension.test/history.html', runScripts: 'outside-only' });
  const commands: HistoryRequest['action'][] = [];
  let archived = false, restored = false, blob: Blob | undefined, download = '';
  const exported = { version: 1, queues: { 'cwq:v1:conversation:test': { items: ['pending text'] } }, archive: ['old text'] };
  Object.defineProperty(dom.window, 'chrome', { value: { runtime: { async sendMessage(message: HistoryRequest) {
    const action = message.action; commands.push(action);
    if (action.type === 'archive') archived = true;
    if (action.type === 'restore') restored = true;
    return { ok: true, data: action.type === 'export' ? exported : action.type === 'list'
      ? { items: archived && !restored ? [{ archiveId: 'archived-1', key: 'conversation:test', text: '<img src=x onerror=alert(1)>' }] : [] }
      : { bytes: 9000, quota: 10000, archived: archived ? 1 : 0 } };
  } } } });
  dom.window.Blob = Blob as unknown as typeof dom.window.Blob;
  dom.window.URL.createObjectURL = value => { blob = value as unknown as Blob; return 'blob:export'; };
  dom.window.HTMLAnchorElement.prototype.click = function () { download = this.download; };
  try {
    dom.window.eval(code); await flush();
    const document = dom.window.document;
    assert.match(document.querySelector('#usage')!.textContent!, /90%.*空间较少/);
    (document.querySelector('#archive') as HTMLElement).click(); await flush();
    assert.equal(document.querySelectorAll('#records li').length, 1);
    assert.equal(document.querySelector('#records img'), null);
    assert.equal(document.querySelector('#records a')!.getAttribute('href'), 'https://chatgpt.com/c/test');
    (document.querySelector('#records button') as HTMLElement).click(); await flush();
    assert.equal(document.querySelectorAll('#records li').length, 0);
    assert.ok(commands.some(action => action.type === 'restore' && action.archiveId === 'archived-1'));
    (document.querySelector('#export') as HTMLElement).click(); await flush();
    assert.match(download, /^chatgpt-queue-\d+\.json$/);
    assert.deepEqual(JSON.parse(await blob!.text()), exported);
  } finally { dom.window.close(); }
});
