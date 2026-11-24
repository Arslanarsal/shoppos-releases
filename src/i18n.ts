import { UR, UR_PATTERNS } from "./i18n-ur";

export type Lang = "en" | "ur";

let lang: Lang = "en";
const original = new WeakMap<Node, { src: string; shown: string }>();
const ATTRS = ["placeholder", "title", "aria-label"];
let observer: MutationObserver | null = null;
let busy = false;

export function getLang(): Lang {
  return lang;
}

export function translate(text: string): string {
  if (lang !== "ur") return text;
  const lead = text.match(/^\s*/)![0];
  const tail = text.match(/\s*$/)![0];
  const core = text.trim();
  if (!core) return text;
  const direct = UR[core];
  if (direct !== undefined) return lead + direct + tail;
  for (const [re, fn] of UR_PATTERNS) {
    const m = core.match(re);
    if (m) return lead + fn(m) + tail;
  }
  return text;
}

function skip(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    const tag = e.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "OPTION" && e.closest("datalist")) return true;
    if (e.hasAttribute?.("data-no-translate")) return true;
  }
  return false;
}

function doText(n: Text) {
  if (skip(n.parentElement)) return;
  const cur = n.nodeValue ?? "";
  const prev = original.get(n);
  const src = prev && cur === prev.shown ? prev.src : cur;
  const want = lang === "ur" ? translate(src) : src;
  original.set(n, { src, shown: want });
  if (cur !== want) n.nodeValue = want;
}

function doAttrs(el: Element) {
  if (skip(el)) return;
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const cur = el.getAttribute(a) ?? "";
    const prevSrc = el.getAttribute(`data-src-${a}`);
    const prevShown = el.getAttribute(`data-shown-${a}`);
    const src = prevSrc !== null && cur === prevShown ? prevSrc : cur;
    const want = lang === "ur" ? translate(src) : src;
    el.setAttribute(`data-src-${a}`, src);
    el.setAttribute(`data-shown-${a}`, want);
    if (cur !== want) el.setAttribute(a, want);
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  doAttrs(el);
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n = tw.nextNode();
  while (n) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text);
    else doAttrs(n as Element);
    n = tw.nextNode();
  }
}

function run(fn: () => void) {
  if (busy) return;
  busy = true;
  observer?.disconnect();
  try {
    fn();
  } finally {
    observer?.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    busy = false;
  }
}

export function setLang(next: Lang) {
  lang = next;
  document.documentElement.lang = next === "ur" ? "ur" : "en";
  document.documentElement.dir = next === "ur" ? "rtl" : "ltr";
  try {
    localStorage.setItem("shoppos-lang", next);
  } catch {
    /* not available */
  }
  run(() => walk(document.body));
}

export function startTranslator() {
  let saved: Lang = "en";
  try {
    saved = localStorage.getItem("shoppos-lang") === "ur" ? "ur" : "en";
  } catch {
    /* not available */
  }
  observer = new MutationObserver((list) => {
    run(() => {
      for (const m of list) {
        if (m.type === "characterData") doText(m.target as Text);
        else if (m.type === "attributes") doAttrs(m.target as Element);
        else m.addedNodes.forEach((n) => walk(n));
      }
    });
  });
  setLang(saved);
}
