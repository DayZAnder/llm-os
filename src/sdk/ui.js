// LLM OS portable UI — a small declarative component model.
//
// Apps describe their interface as a tree of plain data nodes:
//   { t: 'column', props: { gap: 8 }, children: [ { t: 'text', props: {}, children: ['Hi'] } ] }
// built with helpers (LLMOS.ui.c.column(...)), driven by state + a view
// function (LLMOS.ui.app). Because the tree is plain data, the browser is
// just one renderer: the same tree can be serialized (snapshot) and drawn
// by a native renderer straight to a framebuffer.
//
// This file has no dependencies on the page. It defines a factory on the
// global object; the SDK wires it to the DOM, tests run it in Node.

(function (global) {
  'use strict';

  // Component types and the props each accepts. Anything else is dropped,
  // so a model can't invent props that only one renderer understands.
  const LAYOUT = ['key', 'gap', 'padding', 'align', 'justify', 'grow', 'width', 'height', 'surface'];
  const TEXT = ['size', 'weight', 'tone', 'mono', 'wrap'];
  const COMPONENTS = {
    column:   [...LAYOUT],
    row:      [...LAYOUT, 'wrap'],
    scroll:   [...LAYOUT, 'anchor'],
    text:     ['key', 'grow', ...TEXT],
    button:   ['key', 'grow', 'width', 'variant', 'disabled', 'onPress'],
    input:    ['key', 'grow', 'width', 'value', 'placeholder', 'disabled', 'onChange', 'onSubmit'],
    textarea: ['key', 'grow', 'width', 'height', 'value', 'placeholder', 'disabled', 'mono', 'onChange'],
    checkbox: ['key', 'checked', 'label', 'disabled', 'onChange'],
    spacer:   ['key', 'size'],
    divider:  ['key'],
    logo:     ['key', 'size'],   // the LLM OS mark (same as the favicon), themed
  };
  const ENUMS = {
    align: ['start', 'center', 'end', 'stretch'],
    justify: ['start', 'center', 'end', 'between'],
    size: ['sm', 'md', 'lg', 'xl'],
    weight: ['normal', 'bold'],
    tone: ['normal', 'muted', 'accent', 'danger', 'success'],
    variant: ['primary', 'secondary', 'danger', 'ghost'],
    surface: ['none', 'panel', 'card'],
    anchor: ['start', 'end'],
  };
  const HANDLERS = ['onPress', 'onChange', 'onSubmit'];

  // Launcher mark geometry (viewBox 32x32); native/renderer draws the same shapes
  const LOGO_SPARK = 'M14 5C14.9 11.6 17.4 14.1 24 15 17.4 15.9 14.9 18.4 14 25 13.1 18.4 10.6 15.9 4 15 10.6 14.1 13.1 11.6 14 5Z';
  const LOGO_SPARK_SMALL = 'M23.5 18.5C23.9 21 24.8 21.9 27.5 22.5 24.8 23.1 23.9 24 23.5 26.5 23.1 24 22.2 23.1 19.5 22.5 22.2 21.9 23.1 21 23.5 18.5Z';

  function isNode(x) { return x && typeof x === 'object' && typeof x.t === 'string'; }

  function cleanProp(name, value) {
    if (value == null) return undefined;
    if (HANDLERS.includes(name)) return typeof value === 'function' ? value : undefined;
    // size: a named text size, or pixels (text font size, spacer length)
    if (name === 'size' && typeof value === 'number') {
      return Number.isFinite(value) ? Math.max(0, Math.min(value, 200)) : undefined;
    }
    if (ENUMS[name]) return ENUMS[name].includes(value) ? value : undefined;
    switch (name) {
      case 'key': case 'placeholder': case 'label': return String(value).slice(0, 500);
      case 'value': return String(value);
      case 'gap': case 'padding': case 'grow':
        return Number.isFinite(+value) ? Math.max(0, Math.min(+value, name === 'grow' ? 100 : 200)) : undefined;
      case 'width': case 'height':
        if (value === 'fill') return 'fill';
        return Number.isFinite(+value) ? Math.max(0, Math.min(+value, 10000)) : undefined;
      case 'mono': case 'disabled': case 'checked': case 'wrap': return !!value;
      default: return undefined;
    }
  }

  /** Validate and canonicalize a node (recursively). Unknown types render as an error text. */
  function normalize(node) {
    if (node == null || node === false || node === true) return null;
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (!isNode(node)) return { t: 'text', props: { tone: 'danger' }, children: ['[invalid node]'] };
    const allowed = COMPONENTS[node.t];
    if (!allowed) return { t: 'text', props: { tone: 'danger' }, children: [`[unknown component: ${String(node.t).slice(0, 40)}]`] };
    const props = {};
    for (const name of allowed) {
      const v = cleanProp(name, node.props ? node.props[name] : undefined);
      if (v !== undefined) props[name] = v;
    }
    const children = [];
    for (const child of [].concat(node.children || []).flat(Infinity)) {
      const c = normalize(child);
      if (c !== null) children.push(c);
    }
    return { t: node.t, props, children };
  }

  /** JSON-safe copy of a normalized tree: handlers become `true`. For native renderers. */
  function snapshot(node) {
    if (typeof node === 'string') return node;
    const props = {};
    for (const [k, v] of Object.entries(node.props)) props[k] = typeof v === 'function' ? true : v;
    return { t: node.t, props, children: node.children.map(snapshot) };
  }

  // Builders: c.column(props?, ...children). Props may be omitted.
  const c = {};
  for (const t of Object.keys(COMPONENTS)) {
    c[t] = function (props, ...children) {
      if (typeof props === 'string' || typeof props === 'number' || isNode(props) || Array.isArray(props)) {
        children.unshift(props);
        props = {};
      }
      return { t, props: props || {}, children };
    };
  }

  // --- DOM renderer (keyed reconciliation; keeps focus and caret) ---

  const SIZE_PX = { sm: 12, md: 14, lg: 18, xl: 24 };

  function createDomRenderer(root, doc) {
    let prev = null;

    function applyLayout(el, p) {
      const s = el.style;
      if (p.gap != null) s.gap = p.gap + 'px';
      else s.removeProperty('gap');
      if (p.padding != null) s.padding = p.padding + 'px';
      else s.removeProperty('padding');
      s.alignItems = ({ start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' })[p.align || 'stretch'];
      s.justifyContent = ({ start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' })[p.justify || 'start'];
    }
    function applySize(el, p) {
      const s = el.style;
      s.flexGrow = p.grow != null ? String(p.grow) : '';
      s.width = p.width === 'fill' ? '100%' : p.width != null ? p.width + 'px' : '';
      s.height = p.height === 'fill' ? '100%' : p.height != null ? p.height + 'px' : '';
    }

    function create(node) {
      if (typeof node === 'string') return doc.createTextNode(node);
      const tag = { button: 'button', input: 'input', textarea: 'textarea', checkbox: 'label', divider: 'hr' }[node.t] || 'div';
      const el = doc.createElement(tag);
      el.className = 'llu llu-' + node.t;
      el.__llu = { t: node.t, props: {} };
      if (node.t === 'logo') {
        // The launcher mark: a solid accent tile with a spark — deliberately
        // unlike a terminal icon (dark tile, outline, ›_ text)
        const NS = 'http://www.w3.org/2000/svg';
        const svg = doc.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 32 32');
        const part = (tag, attrs) => { const n = doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.appendChild(n); };
        part('rect', { x: 0, y: 0, width: 32, height: 32, rx: 8, fill: 'var(--llmos-accent)' });
        part('path', { d: LOGO_SPARK, fill: 'var(--llmos-accent-fg)' });
        part('path', { d: LOGO_SPARK_SMALL, fill: 'var(--llmos-accent-fg)', opacity: 0.85 });
        el.appendChild(svg);
      }
      if (node.t === 'checkbox') {
        const box = doc.createElement('input');
        box.type = 'checkbox';
        el.appendChild(box);
        el.appendChild(doc.createElement('span'));
        box.addEventListener('change', () => el.__llu.props.onChange && el.__llu.props.onChange(box.checked));
      }
      if (node.t === 'button') el.addEventListener('click', () => el.__llu.props.onPress && el.__llu.props.onPress());
      if (node.t === 'input' || node.t === 'textarea') {
        el.addEventListener('input', () => el.__llu.props.onChange && el.__llu.props.onChange(el.value));
      }
      if (node.t === 'input') {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && el.__llu.props.onSubmit) { e.preventDefault(); el.__llu.props.onSubmit(el.value); }
        });
      }
      update(el, node);
      return el;
    }

    function update(el, node) {
      const p = node.props;
      el.__llu.props = p;
      el.dataset.key = p.key || '';
      switch (node.t) {
        case 'column': case 'row': case 'scroll':
          applyLayout(el, p); applySize(el, p);
          el.dataset.surface = p.surface || 'none';
          if (node.t === 'row') el.style.flexWrap = p.wrap ? 'wrap' : 'nowrap';
          if (node.t === 'scroll' && p.anchor === 'end') {
            // Stick to the bottom (logs, terminals) unless the user scrolled up —
            // also when the window is resized
            if (!el.__lluSeen) {
              el.__lluSeen = true;
              el.__lluAtEnd = true;
              el.addEventListener('scroll', () => { el.__lluAtEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24; });
              if (typeof ResizeObserver !== 'undefined') {
                new ResizeObserver(() => { if (el.__lluAtEnd) el.scrollTop = el.scrollHeight; }).observe(el);
              }
            }
            if (el.__lluAtEnd) Promise.resolve().then(() => { el.scrollTop = el.scrollHeight; });
          }
          break;
        case 'text':
          applySize(el, p);
          el.style.fontSize = (typeof p.size === 'number' ? p.size : SIZE_PX[p.size || 'md']) + 'px';
          el.style.fontWeight = p.weight === 'bold' ? '600' : '400';
          el.dataset.tone = p.tone || 'normal';
          el.style.fontFamily = p.mono ? 'var(--llmos-mono)' : '';
          el.style.whiteSpace = p.wrap === false ? 'nowrap' : 'pre-wrap';
          break;
        case 'button':
          applySize(el, p);
          el.dataset.variant = p.variant || 'secondary';
          el.disabled = !!p.disabled;
          break;
        case 'input': case 'textarea':
          applySize(el, p);
          if (el.value !== (p.value ?? '')) el.value = p.value ?? '';
          el.placeholder = p.placeholder || '';
          el.disabled = !!p.disabled;
          if (node.t === 'textarea') el.style.fontFamily = p.mono ? 'var(--llmos-mono)' : '';
          break;
        case 'checkbox': {
          const [box, label] = el.childNodes;
          box.checked = !!p.checked;
          box.disabled = !!p.disabled;
          label.textContent = p.label || '';
          break;
        }
        case 'spacer':
          el.style.flex = p.size != null ? `0 0 ${p.size}px` : '1 1 auto';
          break;
        case 'logo': {
          const px = (typeof p.size === 'number' ? p.size : 24) + 'px';
          el.style.width = px; el.style.height = px;
          break;
        }
      }
      if (node.t === 'input' || node.t === 'textarea' || node.t === 'checkbox' || node.t === 'divider' || node.t === 'logo') return;
      reconcileChildren(el, node.children);
    }

    const sameKind = (dom, node) => typeof node === 'string'
      ? dom.nodeType === 3
      : dom.nodeType === 1 && dom.__llu && dom.__llu.t === node.t;
    const keyOf = (node, i) => (typeof node === 'string' ? '#text' + i : (node.props.key != null ? 'k:' + node.props.key : node.t + i));

    function reconcileChildren(el, children) {
      const existing = new Map();
      Array.from(el.childNodes).forEach((dom, i) => {
        const k = dom.nodeType === 3 ? '#text' + i : (dom.dataset && dom.dataset.key ? 'k:' + dom.dataset.key : (dom.__llu ? dom.__llu.t + i : '?' + i));
        existing.set(k, dom);
      });
      const next = children.map((child, i) => {
        const k = keyOf(child, i);
        const dom = existing.get(k);
        if (dom && sameKind(dom, child)) {
          existing.delete(k);
          if (typeof child === 'string') { if (dom.nodeValue !== child) dom.nodeValue = child; }
          else update(dom, child);
          return dom;
        }
        return create(child);
      });
      for (const dom of existing.values()) dom.remove();
      next.forEach((dom, i) => {
        if (el.childNodes[i] !== dom) el.insertBefore(dom, el.childNodes[i] || null);
      });
    }

    return {
      render(tree) {
        const node = normalize(tree);
        if (!node || typeof node === 'string') { root.textContent = node || ''; prev = null; return; }
        if (prev && root.firstChild && sameKind(root.firstChild, node)) update(root.firstChild, node);
        else { root.replaceChildren(create(node)); }
        prev = node;
      },
      tree() { return prev; },
    };
  }

  // --- App runtime: state + view, batched re-render ---

  function createApp({ state = {}, view, init }, renderer, onError) {
    if (typeof view !== 'function') throw new Error('LLMOS.ui.app needs a view(state, set) function');
    let current = Object.assign({}, state);
    let scheduled = false;
    const render = () => {
      scheduled = false;
      try { renderer.render(view(current, set)); }
      catch (err) { onError && onError(err); }
    };
    function set(patch) {
      const next = typeof patch === 'function' ? patch(current) : patch;
      if (next && typeof next === 'object') current = Object.assign({}, current, next);
      if (!scheduled) { scheduled = true; Promise.resolve().then(render); }
    }
    render();
    if (typeof init === 'function') {
      Promise.resolve().then(() => init(set, () => current)).catch(err => onError && onError(err));
    }
    return { set, get: () => current, rerender: render };
  }

  const CSS = `
.llu { box-sizing: border-box; min-width: 0; }
.llu-column, .llu-row, .llu-scroll { display: flex; }
.llu-column, .llu-scroll { flex-direction: column; }
.llu-row { flex-direction: row; }
.llu-scroll { overflow: auto; min-height: 0; }
.llu[data-surface="panel"] { background: var(--llmos-surface); border: 1px solid var(--llmos-border); border-radius: var(--llmos-radius); }
.llu[data-surface="card"] { background: var(--llmos-surface-2); border-radius: var(--llmos-radius); }
.llu-text { line-height: 1.45; overflow-wrap: anywhere; }
.llu-text[data-tone="muted"] { color: var(--llmos-muted); }
.llu-text[data-tone="accent"] { color: var(--llmos-accent); }
.llu-text[data-tone="danger"] { color: var(--llmos-danger); }
.llu-text[data-tone="success"] { color: var(--llmos-success); }
.llu-button { font: inherit; font-size: 14px; padding: 7px 14px; border-radius: var(--llmos-radius); border: 1px solid var(--llmos-border); background: var(--llmos-surface-2); color: var(--llmos-fg); cursor: pointer; white-space: nowrap; }
.llu-button[data-variant="primary"] { background: var(--llmos-accent); color: var(--llmos-accent-fg); border-color: var(--llmos-accent); }
.llu-button[data-variant="danger"] { color: var(--llmos-danger); }
.llu-button[data-variant="ghost"] { background: transparent; border-color: transparent; }
.llu-button:hover:not(:disabled) { filter: brightness(1.12); }
.llu-button:disabled { opacity: .45; cursor: default; }
.llu-input, .llu-textarea { font: inherit; font-size: 14px; padding: 7px 10px; border-radius: var(--llmos-radius); border: 1px solid var(--llmos-border); background: var(--llmos-bg); color: var(--llmos-fg); }
.llu-input:focus, .llu-textarea:focus { outline: none; border-color: var(--llmos-accent); }
.llu-textarea { resize: none; line-height: 1.5; }
.llu-checkbox { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.llu-checkbox input { accent-color: var(--llmos-accent); width: 16px; height: 16px; margin: 0; }
.llu-divider { border: 0; border-top: 1px solid var(--llmos-border); margin: 0; width: 100%; }
.llu-logo { flex-shrink: 0; display: inline-flex; }
.llu-logo svg { width: 100%; height: 100%; display: block; }
`;

  global.__LLMOS_UI__ = { COMPONENTS, ENUMS, normalize, snapshot, c, createDomRenderer, createApp, CSS, LOGO_SPARK, LOGO_SPARK_SMALL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
