import { visible } from './adapter.ts';
import { conversationId } from '../naming/types.ts';

export class TitleChangedError extends Error {}
const name = (element: Element) => (element.getAttribute('aria-label') || element.textContent || '').trim();
export function currentTitle(document: Document, id: string): string {
  const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .find(a => conversationId(a.href) === id && !a.hash);
  const title = link && (link.getAttribute('aria-label') || link.getAttribute('title') || link.textContent)?.trim();
  return title || document.title.replace(/\s*[-–|]\s*ChatGPT\s*$/i, '').trim();
}
function buttons(root: ParentNode) { return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter(visible); }
function dialogFrom(document: Document) {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]')).find(dialog =>
    visible(dialog) && !!dialog.querySelector('input[aria-label="Chat title"], input[aria-label="对话标题"], input[aria-label="聊天标题"]'));
}
export async function saveTitle(document: Document, id: string, expected: string, title: string, authorize: () => Promise<void>): Promise<void> {
  const ensureCurrent = () => { if (conversationId(document.location.href) !== id) throw new Error('已切换会话，未应用标题'); };
  const waitFor = async <T>(read: () => T | undefined | false | null, message: string, ms = 4000): Promise<T> => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      ensureCurrent(); const result = read(); if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(message);
  };
  ensureCurrent();
  if (document.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"][data-state="open"]')) throw new Error('请先关闭网页菜单或弹窗，再重新生成标题');
  await authorize();
  const more = buttons(document).find(b => /^(More|更多|更多选项|更多選項|对话选项|聊天选项)$/i.test(name(b)) && b.getAttribute('aria-haspopup') === 'menu');
  if (!more) throw new Error('找不到 ChatGPT 对话菜单，请更新扩展或刷新网页');
  let ownedDialog: HTMLElement | undefined;
  try {
    more.click();
    const rename = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(item => visible(item) && /^(Rename|重命名|重新命名|重新命名对话|重新命名聊天)$/i.test(name(item))), '找不到 ChatGPT 重命名菜单');
    rename.click();
    ownedDialog = await waitFor(() => dialogFrom(document), '找不到 ChatGPT 标题编辑框');
    const input = ownedDialog.querySelector<HTMLInputElement>('input')!;
    if (input.value !== expected) throw new TitleChangedError('标题已由其他操作修改，已保留当前名称并锁定自动命名');
    if (input.value === title) {
      buttons(ownedDialog).find(b => /^(Cancel|取消)$/i.test(name(b)))?.click(); return;
    }
    const setter = Object.getOwnPropertyDescriptor(document.defaultView!.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, title);
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    input.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
    await authorize(); ensureCurrent();
    if (input.value !== title) throw new Error('标题编辑框内容发生变化，未保存');
    const save = buttons(ownedDialog).find(b => /^(Save|保存|儲存)$/i.test(name(b)) && !b.disabled);
    if (!save) throw new Error('ChatGPT 标题保存按钮不可用');
    save.click();
    await waitFor(() => !ownedDialog?.isConnected || !visible(ownedDialog), 'ChatGPT 尚未确认保存标题', 8000);
    await waitFor(() => currentTitle(document, id) === title, '未能核对保存后的标题，请刷新网页检查', 6000);
  } catch (error) {
    if (ownedDialog?.isConnected) buttons(ownedDialog).find(b => /^(Cancel|取消)$/i.test(name(b)))?.click();
    else if (more.getAttribute('aria-expanded') === 'true') more.click();
    throw error;
  }
}
