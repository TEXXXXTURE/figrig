// 意图路由：仅识别 PRD §五 列出的意图枚举，未命中直接抛错。不推断，不返回默认格式。

const INTENT_FORMAT = {
  inspect: 'jsx',
  create: 'json',
  'edit-layout': 'json',
  'edit-style': 'json',
  vector: 'svg',
  review: 'png',
  prototype: 'json',
};

export const INTENTS = Object.freeze(Object.keys(INTENT_FORMAT));

export function selectFormat(intent) {
  if (typeof intent !== 'string' || !Object.prototype.hasOwnProperty.call(INTENT_FORMAT, intent)) {
    throw new Error(`unknown intent: ${String(intent)}; allowed: ${INTENTS.join(', ')}`);
  }
  return INTENT_FORMAT[intent];
}

export default selectFormat;
