const NOTE_TAGS = new Set([
  "B",
  "BLOCKQUOTE",
  "BR",
  "DIV",
  "EM",
  "H2",
  "I",
  "LI",
  "MARK",
  "OL",
  "P",
  "STRONG",
  "U",
  "UL",
]);

export function sanitizeNoteHtml(html: string): string {
  if (typeof document === "undefined") return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitizeChildren(template.content);
  return template.innerHTML;
}

export function notePlainText(html: string): string {
  if (typeof document === "undefined") return "";
  const template = document.createElement("template");
  template.innerHTML = sanitizeNoteHtml(html);
  return (template.content.textContent ?? "").replace(/\u00a0/g, " ").trim();
}

/** execCommand("hiliteColor") 会产出带背景色的 span，这里统一归一化为 mark，保证刷新后高亮仍在、文字为深色。 */
function isHighlightStyle(element: HTMLElement): boolean {
  const background = element.style.backgroundColor || element.style.background;
  const value = background.trim().toLowerCase();
  return value.length > 0 && value !== "transparent" && value !== "none";
}

function sanitizeChildren(parent: ParentNode): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove();
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const element = node as HTMLElement;
    sanitizeChildren(element);
    const tag = element.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "IFRAME" || tag === "OBJECT" || tag === "EMBED") {
      element.remove();
      continue;
    }
    if (tag === "SPAN" && isHighlightStyle(element)) {
      const mark = document.createElement("mark");
      mark.append(...Array.from(element.childNodes));
      element.replaceWith(mark);
      continue;
    }
    if (!NOTE_TAGS.has(tag)) {
      if (tag === "INPUT" && element.getAttribute("type") === "checkbox") {
        element.replaceWith(document.createTextNode(element.hasAttribute("checked") ? "☑ " : "☐ "));
      } else {
        element.replaceWith(...Array.from(element.childNodes));
      }
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      element.removeAttribute(attribute.name);
    }
    if (tag === "DIV") {
      const paragraph = document.createElement("p");
      paragraph.append(...Array.from(element.childNodes));
      element.replaceWith(paragraph);
    } else if (tag === "H2" || tag === "BLOCKQUOTE") {
      element.className = `note-${tag.toLowerCase()}`;
    }
  }
}

