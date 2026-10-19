import { historyRequest } from './client.ts';
import type { ArchivePage, HistoryExport, HistoryStatus } from './core/history.ts';

const usage = document.querySelector<HTMLElement>('#usage')!;
const feedback = document.querySelector<HTMLElement>('#feedback')!;
const records = document.querySelector<HTMLUListElement>('#records')!;
const more = document.querySelector<HTMLButtonElement>('#more')!;
let next: string | undefined;
function message(text: string, error = false) {
  feedback.setAttribute('role', error ? 'alert' : 'status'); feedback.textContent = text;
}
async function status() {
  const data = await historyRequest<HistoryStatus>({ type: 'status' });
  const percent = Math.round(data.bytes / data.quota * 100);
  usage.textContent = `队列存储 ${(data.bytes / 1024 / 1024).toFixed(2)} / ${(data.quota / 1024 / 1024).toFixed(0)} MB（${percent}%），归档 ${data.archived} 条记录。`;
  if (percent >= 80) usage.textContent += ' 空间较少，可将历史记录移入归档。';
}
async function load(reset = false) {
  const page = await historyRequest<ArchivePage>({ type: 'list', ...(reset ? {} : { before: next }) });
  if (reset) records.replaceChildren();
  for (const item of page.items) {
    const li = document.createElement('li');
    const preview = document.createElement('p'); preview.textContent = item.text;
    const conversation = document.createElement('a');
    conversation.href = `https://chatgpt.com/c/${encodeURIComponent(item.key.slice('conversation:'.length))}`;
    conversation.textContent = '打开原会话'; conversation.target = '_blank'; conversation.rel = 'noopener';
    const restore = document.createElement('button'); restore.textContent = '恢复到队尾';
    restore.addEventListener('click', () => void run(restore, async () => {
      await historyRequest({ type: 'restore', archiveId: item.archiveId });
      li.remove(); message('已恢复到原会话队尾，核对后点击继续。'); await status();
    }));
    li.append(preview, conversation, document.createTextNode(' '), restore); records.append(li);
  }
  next = page.next; more.hidden = !next;
}
async function run(button: HTMLButtonElement, work: () => Promise<void>) {
  button.disabled = true;
  try { await work(); } catch (error) { message(String(error), true); }
  finally { button.disabled = false; }
}
const archive = document.querySelector<HTMLButtonElement>('#archive')!;
archive.addEventListener('click', () => void run(archive, async () => {
  await historyRequest({ type: 'archive' }); await status(); await load(true);
  message('历史记录已移入本机归档，可以在下方恢复。');
}));
const download = document.querySelector<HTMLButtonElement>('#export')!;
download.addEventListener('click', () => void run(download, async () => {
  const data = await historyRequest<HistoryExport>({ type: 'export' });
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `chatgpt-queue-${Date.now()}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  message('已生成本地记录导出文件。');
}));
more.addEventListener('click', () => void run(more, () => load()));
void Promise.all([status(), load(true)]).catch(error => message(String(error), true));
