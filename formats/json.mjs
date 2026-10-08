// 原始值 JSON 转换器。仅保留字段白名单，白名单外字段丢弃；children 递归处理。
// 数值与色值原样输出，不做单位换算与色名映射。

const FIELDS = [
  'id',
  'name',
  'type',
  'x',
  'y',
  'width',
  'height',
  'layoutMode',
  'itemSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'fills',
  'characters',
  'fontSize',
];

function pick(node) {
  const out = {};
  if (node === null || typeof node !== 'object') return out;
  for (const key of FIELDS) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  if (Array.isArray(node.children)) out.children = node.children.map(pick);
  return out;
}

export function convert(node) {
  const value = Array.isArray(node) ? node.map(pick) : pick(node);
  return JSON.stringify(value, null, 2);
}

export default convert;
