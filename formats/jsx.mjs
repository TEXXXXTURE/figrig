// 精简 JSX 转换器。Frame 系节点转 div，Text 节点转含文本节点的 span。
// 布局映射：layoutMode -> display:flex 与 flexDirection，itemSpacing -> gap，四向 padding 保留为简写。
// 色值取节点携带的 hex，或由 rgba 分量换算为十六进制；不映射 Tailwind 色名。

const INDENT = '  ';
const FLEX_DIRECTION = { HORIZONTAL: 'row', VERTICAL: 'column' };
const PADDING_KEYS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];

function fixed(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return String(Math.round(value * 1000) / 1000);
}

function byte(value) {
  const n = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 255);
  return n.toString(16).padStart(2, '0').toUpperCase();
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 返回 CSS 可用的色值字符串：hex 优先，其次由 color 分量换算。
export function colorValue(fill) {
  if (fill === null || typeof fill !== 'object') return null;
  if (typeof fill.hex === 'string' && fill.hex.length > 0) return fill.hex;
  const color = fill.color;
  if (color === null || typeof color !== 'object') return null;
  const hex = `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
  const alpha = typeof color.a === 'number'
    ? color.a
    : (typeof fill.opacity === 'number' ? fill.opacity : 1);
  if (alpha >= 0.999) return hex;
  const r = Math.round(Math.max(0, Math.min(1, Number(color.r) || 0)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, Number(color.g) || 0)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, Number(color.b) || 0)) * 255);
  return `rgba(${r},${g},${b},${Math.round(alpha * 100) / 100})`;
}

function backgroundColor(fills) {
  if (!Array.isArray(fills)) return null;
  for (const fill of fills) {
    if (fill === null || typeof fill !== 'object') continue;
    if (fill.visible === false) continue;
    if (fill.type !== undefined && fill.type !== 'SOLID') continue;
    const value = colorValue(fill);
    if (value) return value;
  }
  return null;
}

function paddingValues(node) {
  if (!PADDING_KEYS.some((key) => typeof node[key] === 'number')) return null;
  return PADDING_KEYS
    .map((key) => `${typeof node[key] === 'number' ? fixed(node[key]) : 0}px`)
    .join(' ');
}

function styleString(node) {
  const parts = [];
  const width = fixed(node.width);
  const height = fixed(node.height);
  if (width !== null) parts.push(`width:${width}`);
  if (height !== null) parts.push(`height:${height}`);
  if (typeof node.layoutMode === 'string' && FLEX_DIRECTION[node.layoutMode]) {
    parts.push("display:'flex'");
    parts.push(`flexDirection:'${FLEX_DIRECTION[node.layoutMode]}'`);
  }
  const gap = fixed(node.itemSpacing);
  if (gap !== null) parts.push(`gap:${gap}`);
  const padding = paddingValues(node);
  if (padding) parts.push(`padding:'${padding}'`);
  const background = backgroundColor(node.fills);
  if (background) parts.push(`backgroundColor:'${background}'`);
  const fontSize = fixed(node.fontSize);
  if (fontSize !== null) parts.push(`fontSize:${fontSize}`);
  return parts.join(', ');
}

function attributeString(node) {
  const parts = [];
  if (typeof node.id === 'string' && node.id.length > 0) parts.push(`id="${escapeAttribute(node.id)}"`);
  if (typeof node.name === 'string' && node.name.length > 0) parts.push(`name="${escapeAttribute(node.name)}"`);
  const style = styleString(node);
  if (style) parts.push(`style={{${style}}}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function render(node, depth) {
  const pad = INDENT.repeat(depth);
  if (node === null || typeof node !== 'object') return '';
  if (node.type === 'TEXT') {
    const attrs = attributeString(node);
    const characters = typeof node.characters === 'string' ? node.characters : '';
    if (characters.length === 0) return `${pad}<span${attrs} />`;
    return `${pad}<span${attrs}>${escapeText(characters)}</span>`;
  }
  const attrs = attributeString(node);
  const children = Array.isArray(node.children) ? node.children : [];
  if (children.length === 0) return `${pad}<div${attrs} />`;
  const inner = children.map((child) => render(child, depth + 1)).filter(Boolean).join('\n');
  if (inner.length === 0) return `${pad}<div${attrs} />`;
  return `${pad}<div${attrs}>\n${inner}\n${pad}</div>`;
}

export function convert(node) {
  if (Array.isArray(node)) {
    return node.map((item) => render(item, 0)).filter(Boolean).join('\n');
  }
  return render(node, 0);
}

export default convert;
