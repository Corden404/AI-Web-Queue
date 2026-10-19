import type { Action, QueueItem, QueueState } from '../core/types.ts';
import { icon } from './icons.ts';
import css from './queue.css?inline';

export interface PanelView {
  state: QueueState | null;
  owned: boolean;
  busy: boolean;
  enabled: boolean;
  settingsReady: boolean;
  waitingForConversation: boolean;
  hasText: boolean;
  blocked: string;
  error: string;
  dark: boolean;
}
export class QueuePanel {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  private body: HTMLElement;
  private layerStyle: HTMLStyleElement;
  private view: PanelView | null = null;
  private collapsed = false;
  private editing: string | null = null;
  private editStarting = false;
  private editText = '';
  private dragId: string | null = null;
  private menuId: string | null = null;
  private dismissedRemoval: string | null = null;
  private expanded = new Set<string>();
  private lastRender = '';
  constructor(private document: Document, private action: (action: Action) => Promise<void>, private enqueue: () => void) {
    this.host = document.createElement('div');
    this.host.id = 'chatgpt-web-queue';
    this.host.hidden = true;
    // Page-wide CSS resets take precedence over :host rules in a shadow tree.
    this.host.style.marginBottom = '-20px';
    this.host.setAttribute('data-markdown-copy', 'exclude');
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = css;
    this.body = document.createElement('section');
    this.body.setAttribute('aria-label', '待发送消息队列');
    this.body.className = 'wrap';
    this.root.append(style, this.body);
    this.layerStyle = document.createElement('style');
    // Let the native composer cover the tray's bottom edge without restyling it.
    this.layerStyle.textContent = '#chatgpt-web-queue:not([hidden]) + :is(form, [data-chatgpt-composer]) { isolation: isolate; }';
    document.addEventListener('click', event => {
      if (this.menuId && !event.composedPath().includes(this.host)) this.closeMenu();
    });
    this.root.addEventListener('keydown', event => {
      const key = event as KeyboardEvent;
      if (key.key === 'Escape' && this.menuId) { key.preventDefault(); key.stopPropagation(); this.closeMenu(true); }
    });
  }
  mount(form: HTMLElement) {
    if (!this.layerStyle.isConnected) this.document.head.append(this.layerStyle);
    if (this.host.nextElementSibling !== form) form.before(this.host);
  }
  unmount() { this.host.remove(); this.editing = null; this.menuId = null; this.lastRender = ''; }
  reset() {
    this.editing = null; this.menuId = null; this.collapsed = false; this.lastRender = '';
    this.expanded.clear(); this.dismissedRemoval = null;
  }
  private button(title: string, html: string, callback: () => void, className = 'icon-button'): HTMLButtonElement {
    const b = this.document.createElement('button');
    b.type = 'button'; b.className = className; b.title = title; b.setAttribute('aria-label', title);
    b.innerHTML = html; b.addEventListener('click', callback); return b;
  }
  private redraw() { this.lastRender = ''; if (this.view) this.render(this.view); }
  private closeMenu(focus = false) {
    const id = this.menuId; this.menuId = null; this.redraw();
    if (focus) this.focusControl(`more:${id}`);
  }
  private focusControl(key: string) {
    [...this.root.querySelectorAll<HTMLElement>('[data-focus]')].find(el => el.dataset.focus === key)?.focus();
  }
  render(view: PanelView) {
    this.view = view;
    const state = view.state;
    const digest = JSON.stringify([state?.revision, view.owned, view.busy, view.enabled,
      view.settingsReady, view.waitingForConversation, view.hasText, view.blocked, view.error, view.dark, this.collapsed, this.menuId, this.dismissedRemoval]);
    this.host.toggleAttribute('data-dark', view.dark);
    if (digest === this.lastRender) return;
    this.lastRender = digest;
    // Storage updates must preserve an in-progress edit and its selection.
    const oldEditor = this.root.querySelector<HTMLTextAreaElement>('textarea');
    if (oldEditor && this.editing && state?.editing?.itemId === this.editing) this.editText = oldEditor.value;
    else if (!this.editStarting && (!state?.editing || state.editing.itemId !== this.editing)) this.editing = null;
    const focusedEdit = !!oldEditor && this.root.activeElement === oldEditor;
    const focusedControl = (this.root.activeElement as HTMLElement | null)?.dataset.focus;
    const selection = oldEditor ? [oldEditor.selectionStart, oldEditor.selectionEnd] : null;
    this.body.replaceChildren();
    const hasQueue = !!state?.items.length;
    const undo = state?.removed.at(-1);
    const showUndo = !!undo && undo.id !== this.dismissedRemoval;
    this.host.hidden = !view.settingsReady || !view.enabled || (!hasQueue && !view.error && !showUndo && !view.waitingForConversation);
    if (this.host.hidden) { this.menuId = null; return; }
    if (hasQueue) {
      const list = this.document.createElement('div'); list.className = 'list'; list.setAttribute('role', 'list');
      const items = this.collapsed ? state.items.slice(0, 1) : state.items;
      for (const item of items) list.append(this.card(item, state, view));
      this.dropTarget(list, null, true); this.body.append(list);
      if (this.collapsed && state.items.length > 1) {
        this.body.append(this.button(`展开另外 ${state.items.length - 1} 条消息`, `${icon('chevron')}<span>另外 ${state.items.length - 1} 条待发送</span>`, () => {
          this.collapsed = false; this.redraw();
        }, 'collapsed-summary'));
      }
      const status = state.editing ? '编辑中 · 自动发送暂缓' : !view.owned ? '由另一个标签页发送' :
        state.paused ? '已暂停' : view.blocked && !view.busy && view.blocked !== '等待本轮回答完成' ? view.blocked : '';
      if (status) {
        const line = this.document.createElement('div'); line.className = 'state-line';
        const label = this.document.createElement('span'); label.textContent = status;
        line.append(label);
        if (!view.owned) line.append(this.button('接管此会话的队列发送', '在此标签页接管', () => void this.action({ type: 'takeover' }), 'text-action'));
        else if (state.paused && !state.editing && !state.handoff) line.append(this.button('继续自动发送', `${icon('play')}继续`, () => void this.action({ type: 'pause', paused: false }), 'text-action'));
        this.body.append(line);
      }
      if (state.paused && state.reason) this.message(state.reason);
    }
    if (view.error) this.message(view.error, true);
    if (view.waitingForConversation) this.message('正在等待会话创建，准备加入队列');
    if (showUndo) {
      const toast = this.document.createElement('div'); toast.className = 'toast';
      toast.append(this.document.createTextNode('已移除一条消息'),
        this.button('恢复最近移除的消息', `${icon('undo')}撤销`, () => void this.action({ type: 'restore', id: undo!.id }), 'text-action'),
        this.button('关闭撤销提示', icon('close'), () => { this.dismissedRemoval = undo!.id; this.redraw(); }, 'dismiss'));
      this.body.append(toast);
    }
    if (this.menuId && state) {
      const item = state.items.find(item => item.id === this.menuId);
      if (item) this.menu(item, state, view); else this.menuId = null;
    }
    if (focusedEdit) {
      const edit = this.root.querySelector<HTMLTextAreaElement>('textarea');
      edit?.focus(); if (selection) edit?.setSelectionRange(selection[0]!, selection[1]!);
    } else if (focusedControl) this.focusControl(focusedControl);
  }
  private message(text: string, error = false) {
    const message = this.document.createElement('div'); message.className = `message${error ? ' error' : ''}`;
    message.setAttribute('role', error ? 'alert' : 'status'); message.textContent = text; this.body.append(message);
  }
  private dropTarget(element: HTMLElement, beforeId: string | null, end = false) {
    element.addEventListener('dragover', event => {
      if (this.dragId && (!end || event.target === element)) { event.preventDefault(); event.stopPropagation(); element.setAttribute('data-drop', ''); }
    });
    element.addEventListener('dragleave', () => element.removeAttribute('data-drop'));
    element.addEventListener('drop', event => {
      if (end && event.target !== element) return;
      event.preventDefault(); event.stopPropagation(); element.removeAttribute('data-drop');
      if (this.dragId) void this.action({ type: 'move', id: this.dragId, beforeId });
      this.dragId = null;
    });
  }
  private async move(item: QueueItem, state: QueueState, down: boolean) {
    const index = state.items.findIndex(i => i.id === item.id);
    const target = down ? state.items[index + 2]?.id ?? null : state.items[index - 1]?.id;
    if (target === undefined) return;
    await this.action({ type: 'move', id: item.id, beforeId: target });
    this.focusControl(`grip:${item.id}`);
  }
  private startEdit(item: QueueItem) {
    this.menuId = null; this.editing = item.id; this.editText = item.text; this.editStarting = true;
    void this.action({ type: 'editStart', id: item.id }).finally(() => {
      this.editStarting = false;
      this.root.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    });
  }
  private card(item: QueueItem, state: QueueState, view: PanelView): HTMLElement {
    const card = this.document.createElement('div'); card.className = 'card'; card.dataset.itemId = item.id; card.setAttribute('role', 'listitem');
    card.toggleAttribute('data-sending', item.status === 'sending');
    card.toggleAttribute('data-expanded', this.expanded.has(item.id));
    const isEditing = this.editing === item.id && state.editing?.itemId === item.id;
    card.toggleAttribute('data-editing', isEditing);
    const grip = this.button('拖动排序；方向键上移或下移', icon('queue'), () => {}, 'grip');
    grip.dataset.focus = `grip:${item.id}`;
    grip.disabled = item.status !== 'queued'; grip.draggable = !grip.disabled;
    grip.addEventListener('dragstart', event => { this.dragId = item.id; event.dataTransfer?.setData('text/plain', item.id); card.setAttribute('data-dragging', ''); });
    grip.addEventListener('dragend', () => { this.dragId = null; card.removeAttribute('data-dragging'); });
    grip.addEventListener('keydown', event => {
      const index = state.items.findIndex(i => i.id === item.id);
      if (event.key === 'ArrowUp' && index > 0 && state.items[index - 1]?.status === 'queued') {
        event.preventDefault(); void this.move(item, state, false);
      } else if (event.key === 'ArrowDown' && index < state.items.length - 1) {
        event.preventDefault(); void this.move(item, state, true);
      }
    });
    if (item.status === 'queued') this.dropTarget(card, item.id);
    const body = this.document.createElement('div'); body.className = 'body';
    if (isEditing) {
      const text = this.document.createElement('textarea'); text.className = 'edit-area'; text.value = this.editText;
      text.setAttribute('aria-label', '编辑队列消息');
      text.addEventListener('input', () => { this.editText = text.value; });
      text.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); void this.action({ type: 'editCancel' }); }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
          event.preventDefault(); void this.action({ type: 'editSave', id: item.id, text: text.value });
        }
      });
      const editActions = this.document.createElement('div'); editActions.className = 'edit-actions';
      editActions.append(this.button('取消编辑', '取消', () => void this.action({ type: 'editCancel' }), 'small'),
        this.button('保存消息', '保存', () => void this.action({ type: 'editSave', id: item.id, text: text.value }), 'small primary'));
      body.append(text, editActions);
    } else {
      const preview = this.button('展开或收起消息全文', '', () => {
        this.expanded.has(item.id) ? this.expanded.delete(item.id) : this.expanded.add(item.id); this.redraw();
      }, 'preview');
      preview.dataset.focus = `preview:${item.id}`; preview.setAttribute('aria-expanded', String(this.expanded.has(item.id)));
      preview.removeAttribute('aria-label'); preview.textContent = item.text; body.append(preview);
      if (item.status === 'sending') {
        const badge = this.document.createElement('span'); badge.className = 'badge'; badge.innerHTML = '<span class="spinner"></span>发送中'; body.append(badge);
      }
      if (item.status === 'uncertain') {
        const message = this.document.createElement('div'); message.className = 'uncertain'; message.textContent = '发送结果待确认，请检查会话中是否已有这条消息。';
        const resolve = this.document.createElement('div'); resolve.className = 'resolve';
        for (const [text, delivered] of [['已发送', true], ['尚未发送', false]] as const)
          resolve.append(this.button(text, text, () => void this.action({ type: 'resolve', id: item.id, delivered }), 'small'));
        body.append(message, resolve);
      }
    }
    const controls = this.document.createElement('div'); controls.className = 'card-actions';
    const remove = this.button('移除消息', icon('trash'), () => void this.action({ type: 'remove', id: item.id }));
    remove.disabled = item.status !== 'queued' || (!!state.editing && state.editing.itemId !== item.id);
    const more = this.button('更多队列操作', icon('more'), () => {
      this.menuId = this.menuId === item.id ? null : item.id; this.redraw();
      this.root.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus();
    });
    more.dataset.focus = `more:${item.id}`; more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', String(this.menuId === item.id));
    controls.append(remove, more); card.append(grip, body, controls); return card;
  }
  private menu(item: QueueItem, state: QueueState, view: PanelView) {
    const menu = this.document.createElement('div'); menu.className = 'menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '队列操作');
    const add = (text: string, glyph: string, run: () => void, disabled = false) => {
      const button = this.button(text, `${icon(glyph)}<span>${text}</span>`, () => {
        this.menuId = null; run(); this.redraw();
      }, 'menu-item');
      button.setAttribute('role', 'menuitem'); button.disabled = disabled; button.dataset.focus = `menu:${text}`; menu.append(button);
    };
    const index = state.items.findIndex(i => i.id === item.id);
    const editable = item.status === 'queued' && !state.editing;
    add('编辑消息', 'edit', () => this.startEdit(item), !editable);
    add('上移', 'up', () => void this.move(item, state, false), !editable || index === 0 || state.items[index - 1]?.status !== 'queued');
    add('下移', 'down', () => void this.move(item, state, true), !editable || index === state.items.length - 1);
    const divider = this.document.createElement('div'); divider.className = 'menu-divider'; menu.append(divider);
    if (!view.owned) add('在此标签页接管', 'play', () => void this.action({ type: 'takeover' }));
    else add(state.paused ? '继续自动发送' : '暂停自动发送', state.paused ? 'play' : 'pause', () => void this.action({ type: 'pause', paused: !state.paused }));
    if (state.items.length > 1) add(this.collapsed ? '展开队列' : '折叠队列', 'chevron', () => { this.collapsed = !this.collapsed; });
    add('将输入框草稿加入队列', 'add', this.enqueue, !view.hasText);
    if (state.removed.length) add('恢复最近移除的消息', 'undo', () => void this.action({ type: 'restore', id: state.removed.at(-1)!.id }));
    menu.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab'].includes(event.key)) return;
      if (event.key === 'Tab') { this.closeMenu(true); return; }
      event.preventDefault();
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(this.root.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
    this.body.append(menu);
    const trigger = [...this.root.querySelectorAll<HTMLElement>('[data-focus]')].find(el => el.dataset.focus === `more:${item.id}`)!;
    const offset = trigger.getBoundingClientRect().top - this.body.getBoundingClientRect().top;
    menu.style.bottom = `${this.body.offsetHeight - offset + 4}px`;
  }
}
