import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TranscriptSegment } from "@shared/contracts/transcript";
import { formatClock } from "../monitor/format";
import { notePlainText, sanitizeNoteHtml } from "./noteDocument";

const STORAGE_KEY = "ai-dingbo.live-notes.v1";
const EMPTY_NOTE = "<p><br></p>";
const SAVE_DELAY_MS = 500;
const HIGHLIGHT_COLOR = "#f2c14e";

type LiveNotesPanelProps = {
  clockMs: number;
  latestSegment: TranscriptSegment | null;
};

type SaveState = "saved" | "saving" | "error";

export function LiveNotesPanel({ clockMs, latestSegment }: LiveNotesPanelProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const initialHtml = useRef(loadNote());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHtml = useRef<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [plainText, setPlainText] = useState(() => notePlainText(initialHtml.current));
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = initialHtml.current;
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (pendingHtml.current != null) persistNote(pendingHtml.current);
    };
  }, []);

  function readEditor(): string {
    return sanitizeNoteHtml(editorRef.current?.innerHTML ?? "");
  }

  function queueSave() {
    const html = readEditor();
    const text = notePlainText(html);
    setPlainText(text);
    setSaveState("saving");
    setNotice(null);
    setConfirmClear(false);
    pendingHtml.current = html;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const pending = pendingHtml.current;
      pendingHtml.current = null;
      if (pending == null) return;
      setSaveState(persistNote(pending) ? "saved" : "error");
    }, SAVE_DELAY_MS);
  }

  function editorRange(): { editor: HTMLDivElement; selection: Selection; range: Range } | null {
    const editor = editorRef.current;
    if (!editor) return null;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return null;
    let range = selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    return { editor, selection, range };
  }

  function runCommand(command: string, value?: string) {
    if (!editorRange()) return;
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(command, false, value);
    queueSave();
  }

  function toggleHighlight() {
    const context = editorRange();
    if (!context) return;
    const { editor, selection, range } = context;
    if (range.collapsed) return;
    const nodes = textNodesInRange(range, editor);
    if (nodes.length === 0) return;
    const highlights = new Set<HTMLElement>();
    const allHighlighted = nodes.every((node) => {
      const highlight = closestHighlight(node, editor);
      if (highlight) highlights.add(highlight);
      return highlight != null;
    });
    if (allHighlighted) {
      highlights.forEach(unwrapHighlight);
    } else {
      document.execCommand("styleWithCSS", false, "false");
      document.execCommand("hiliteColor", false, HIGHLIGHT_COLOR);
      const active = selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      normalizeHighlightSpans(editor);
      if (active && editor.contains(active.commonAncestorContainer)) {
        selection.removeAllRanges();
        selection.addRange(active);
      }
    }
    queueSave();
  }

  function clearFormatting() {
    const context = editorRange();
    if (!context) return;
    const { editor, selection, range } = context;
    const children = Array.from(editor.childNodes);
    if (children.length === 0) return;
    const affected = range.collapsed ? children : children.filter((node) => range.intersectsNode(node));
    if (affected.length === 0) return;

    const fragment = document.createDocumentFragment();
    const paragraphs: HTMLParagraphElement[] = [];
    for (const block of affected) {
      for (const line of blockPlainLines(block)) {
        const paragraph = document.createElement("p");
        paragraph.textContent = line;
        fragment.appendChild(paragraph);
        paragraphs.push(paragraph);
      }
    }
    if (paragraphs.length === 0) {
      const paragraph = document.createElement("p");
      paragraph.appendChild(document.createElement("br"));
      fragment.appendChild(paragraph);
      paragraphs.push(paragraph);
    }
    editor.insertBefore(fragment, affected[0]);
    affected.forEach((block) => block.remove());

    const caret = document.createRange();
    caret.selectNodeContents(paragraphs[paragraphs.length - 1]);
    caret.collapse(false);
    selection.removeAllRanges();
    selection.addRange(caret);
    queueSave();
  }

  function insertFragment(fragment: DocumentFragment, block = false) {
    const context = editorRange();
    if (!context) return;
    const { editor, selection } = context;
    const { range } = context;
    if (block) {
      const containingBlock = closestBlock(range.startContainer, editor);
      if (containingBlock) range.setStartAfter(containingBlock);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(fragment);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    queueSave();
  }

  function insertTimestamp() {
    const fragment = document.createDocumentFragment();
    const mark = document.createElement("mark");
    mark.textContent = `[${formatClock(clockMs)}] `;
    fragment.appendChild(mark);
    insertFragment(fragment);
  }

  function insertLatestSegment() {
    if (!latestSegment) return;
    const fragment = document.createDocumentFragment();
    const quote = document.createElement("blockquote");
    quote.className = "note-blockquote";
    const time = document.createElement("strong");
    time.textContent = `[${formatClock(latestSegment.startMs)}] `;
    quote.append(time, document.createTextNode(latestSegment.text));
    fragment.appendChild(quote);
    fragment.appendChild(document.createElement("p"));
    insertFragment(fragment, true);
  }

  async function copyNotes() {
    const text = notePlainText(readEditor());
    if (!text) {
      setNotice("笔记还是空的，没有可复制的内容。");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制笔记全文。");
    } catch {
      setNotice("复制失败，请手动选择笔记内容复制。");
    }
  }

  function clearNotes() {
    if (!confirmClear) {
      setConfirmClear(true);
      setNotice("再次点击“清空”确认，笔记内容将无法恢复。");
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (editorRef.current) editorRef.current.innerHTML = EMPTY_NOTE;
    pendingHtml.current = null;
    setSaveState(persistNote(EMPTY_NOTE) ? "saved" : "error");
    setPlainText("");
    setConfirmClear(false);
    setNotice("笔记已清空。");
    editorRange();
  }

  return (
    <section className="notes-panel" aria-label="直播工具">
      <div id="live-notes-content" className="notes-content">
      <header className="notes-head">
        <div className="notes-title">
          <p className="notes-eyebrow">实验特性 · 不进验收</p>
          <h2>直播笔记</h2>
        </div>
        <span className={`save-state save-${saveState}`} role="status">
          {saveState === "saving" ? "保存中…" : saveState === "error" ? "保存失败" : "已保存到本机"}
        </span>
      </header>

      <div className="notes-quick-tools" aria-label="字幕快捷工具">
        <button type="button" onClick={insertTimestamp} title="在光标处插入当前直播时间">
          插入时间戳 <kbd>{formatClock(clockMs)}</kbd>
        </button>
        <button type="button" onClick={insertLatestSegment} disabled={!latestSegment} title="在光标处引用最新一条字幕">
          引用最新字幕
        </button>
      </div>

      <div className="notes-toolbar" role="toolbar" aria-label="笔记格式工具">
        <ToolButton label="撤销" title="撤销" onClick={() => runCommand("undo")}>↶</ToolButton>
        <ToolButton label="重做" title="重做" onClick={() => runCommand("redo")}>↷</ToolButton>
        <span className="toolbar-divider" aria-hidden="true" />
        <select
          aria-label="段落样式"
          defaultValue="p"
          onChange={(event) => {
            runCommand("formatBlock", event.target.value);
            event.target.value = "p";
          }}
        >
          <option value="p">正文</option>
          <option value="h2">标题</option>
          <option value="blockquote">引用</option>
        </select>
        <ToolButton label="加粗" title="加粗" onClick={() => runCommand("bold")}><strong>B</strong></ToolButton>
        <ToolButton label="斜体" title="斜体" onClick={() => runCommand("italic")}><em>I</em></ToolButton>
        <ToolButton label="下划线" title="下划线" onClick={() => runCommand("underline")}><u>U</u></ToolButton>
        <ToolButton label="高亮" title="高亮 / 取消高亮" onClick={toggleHighlight}><mark>高亮</mark></ToolButton>
        <ToolButton label="无序列表" title="无序列表" onClick={() => runCommand("insertUnorderedList")}>• 列表</ToolButton>
        <ToolButton label="有序列表" title="有序列表" onClick={() => runCommand("insertOrderedList")}>1. 列表</ToolButton>
        <ToolButton label="待办事项" title="插入待办事项" onClick={() => runCommand("insertText", "☐ ")}>☐ 待办</ToolButton>
        <ToolButton label="清除格式" title="清除笔记中的时间戳、引用、标题等所有格式" onClick={clearFormatting}>清除格式</ToolButton>
      </div>

      <div
        ref={editorRef}
        className="notes-editor"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="直播笔记编辑区"
        data-placeholder="记录本场商品信息、优惠机制、待跟进事项……"
        suppressContentEditableWarning
        onInput={queueSave}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          document.execCommand("insertText", false, text);
          queueSave();
        }}
      />

      <footer className="notes-footer">
        <span>{plainText.length} 字</span>
        <div>
          <button type="button" onClick={() => void copyNotes()}>复制全文</button>
          <button type="button" className={confirmClear ? "danger-confirm" : ""} onClick={clearNotes}>
            {confirmClear ? "确认清空" : "清空"}
          </button>
        </div>
      </footer>
      {notice ? <p className="notes-notice" role="status">{notice}</p> : null}
      </div>
    </section>
  );
}

function closestBlock(node: Node, editor: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== editor) {
    if (current instanceof HTMLElement && ["P", "H2", "BLOCKQUOTE", "LI", "DIV"].includes(current.tagName)) return current;
    current = current.parentNode;
  }
  return null;
}

function textNodesInRange(range: Range, editor: HTMLElement): Text[] {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    if ((node.nodeValue ?? "").trim().length > 0 && range.intersectsNode(node)) nodes.push(node);
    current = walker.nextNode();
  }
  return nodes;
}

function closestHighlight(node: Node, editor: HTMLElement): HTMLElement | null {
  let current: Node | null = node.parentNode;
  while (current && current !== editor) {
    if (current instanceof HTMLElement && (current.tagName === "MARK" || isHighlightSpan(current))) return current;
    current = current.parentNode;
  }
  return null;
}

function isHighlightSpan(element: HTMLElement): boolean {
  if (element.tagName !== "SPAN") return false;
  const background = (element.style.backgroundColor || element.style.background).trim().toLowerCase();
  return background.length > 0 && background !== "transparent" && background !== "none";
}

function unwrapHighlight(element: HTMLElement) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
  parent.normalize();
}

function normalizeHighlightSpans(root: HTMLElement) {
  root.querySelectorAll("span").forEach((node) => {
    const span = node as HTMLElement;
    if (!isHighlightSpan(span)) return;
    const mark = document.createElement("mark");
    while (span.firstChild) mark.appendChild(span.firstChild);
    span.replaceWith(mark);
  });
}

/** 把块级内容摊平成纯文本行：去掉标题、引用、列表、时间戳高亮等所有结构。 */
function blockPlainLines(block: Node): string[] {
  if (block.nodeType === Node.TEXT_NODE) {
    const text = (block.nodeValue ?? "").replace(/\u00a0/g, " ").trim();
    return text.length > 0 ? [text] : [];
  }
  const holder = document.createElement("div");
  holder.appendChild(block.cloneNode(true));
  holder.querySelectorAll("br").forEach((br) => br.replaceWith(document.createTextNode("\n")));
  holder.querySelectorAll("li").forEach((li) => {
    li.insertAdjacentText("beforebegin", "\n");
    li.insertAdjacentText("afterend", "\n");
  });
  return (holder.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function ToolButton({ label, title, onClick, children }: { label: string; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={title} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

function persistNote(html: string): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, html, updatedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

function loadNote(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_NOTE;
    const saved = JSON.parse(raw) as { version?: number; html?: unknown };
    if (saved.version !== 1 || typeof saved.html !== "string") return EMPTY_NOTE;
    return sanitizeNoteHtml(saved.html) || EMPTY_NOTE;
  } catch {
    return EMPTY_NOTE;
  }
}
