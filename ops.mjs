// 操作枚举与预期断言推导。枚举与 plugin/main.js 的 WRITE_OPS 一致。
// expectedAssertions 由操作与参数推导断言文本，供故障恢复核验与组件模板复放使用。

export const WRITE_OPS = Object.freeze([
  'create-frame',
  'create-rectangle',
  'create-text',
  'move',
  'resize',
  'delete',
  'set-fill',
  'set-layout',
  'set-padding',
  'set-item-spacing',
]);

export const CREATE_OPS = Object.freeze(['create-frame', 'create-rectangle', 'create-text']);
export const WRITE_SET = new Set(WRITE_OPS);
export const CREATE_SET = new Set(CREATE_OPS);

const PADDING_KEYS = ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'];

// 由操作与参数推导预期断言。返回断言文本数组，元素形如 name=Panel 或 fills[0].hex=#112233。
export function expectedAssertions(operation, params = {}) {
  const out = [];
  const add = (path, value) => {
    if (value !== undefined && value !== null) out.push(`${path}=${value}`);
  };
  switch (operation) {
    case 'create-frame':
    case 'create-rectangle':
    case 'create-text':
      if (typeof params.name === 'string') add('name', params.name);
      if (typeof params.characters === 'string') add('characters', params.characters);
      add('width', params.width);
      add('height', params.height);
      add('x', params.x);
      add('y', params.y);
      break;
    case 'move':
      add('x', params.x);
      add('y', params.y);
      break;
    case 'resize':
      add('width', params.width);
      add('height', params.height);
      break;
    case 'set-fill':
      if (typeof params.hex === 'string') add('fills[0].hex', params.hex.toUpperCase());
      break;
    case 'set-layout':
      if (typeof params.layoutMode === 'string') add('layoutMode', params.layoutMode);
      break;
    case 'set-padding':
      if (typeof params.padding === 'number') {
        for (const key of PADDING_KEYS) add(key, params.padding);
      }
      for (const key of PADDING_KEYS) add(key, params[key]);
      break;
    case 'set-item-spacing':
      add('itemSpacing', params.itemSpacing);
      break;
    default:
      break;
  }
  return out;
}

export default expectedAssertions;
