// 桩 Figma 环境：内存节点树与消息驱动的插件加载。用于插件逻辑校验与端到端联调。
// 节点方法覆盖 create/appendChild/resize/remove/exportAsync；导出固定 8 字节 PNG 签名。

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// 构造带内存节点树与 create* 工厂的桩 figma 对象。
// 返回 { figma, registry, StubNode, add }；registry 为 id -> 节点映射。
export function createStubFigma() {
  const registry = new Map();
  let counter = 100;

  class StubNode {
    constructor(type, name) {
      this.id = `1:${counter}`;
      counter += 1;
      this.type = type;
      this.name = name ?? type;
      this.x = 0;
      this.y = 0;
      this.width = 100;
      this.height = 100;
      this.parent = null;
      this._children = [];
      this.reactions = [];
    }

    get children() {
      return this._children;
    }

    appendChild(child) {
      child.parent = this;
      this._children.push(child);
    }

    resize(width, height) {
      this.width = width;
      this.height = height;
    }

    remove() {
      if (this.parent) {
        const index = this.parent._children.indexOf(this);
        if (index >= 0) this.parent._children.splice(index, 1);
        this.parent = null;
      }
      registry.delete(this.id);
    }

    exportAsync() {
      return new Uint8Array(EXPORT_BYTES);
    }
  }

  // create* 工厂返回的节点自动进入 registry，模拟 Figma 文档中的既有节点。
  function factoryNode(type, name) {
    const node = new StubNode(type, name);
    registry.set(node.id, node);
    return node;
  }

  const figma = {
    fileKey: 'stub-file',
    apiVersion: '1.0',
    editorType: 'figma',
    root: { name: 'Stub' },
    showUI() {},
    createFrame() {
      return factoryNode('FRAME', 'Frame');
    },
    createRectangle() {
      return factoryNode('RECTANGLE', 'Rectangle');
    },
    createText() {
      return factoryNode('TEXT', 'Text');
    },
    async loadFontAsync(font) {
      if (font === null || typeof font !== 'object' || typeof font.family !== 'string') {
        throw new Error('invalid font');
      }
      return null;
    },
    async getNodeByIdAsync(id) {
      return registry.has(id) ? registry.get(id) : null;
    },
    ui: {
      onmessage: null,
      postMessage() {},
    },
  };

  function add(node) {
    registry.set(node.id, node);
    return node;
  }

  return { figma, registry, StubNode, add };
}

// 以桩 figma 全局加载 plugin/main.js，捕获 postMessage 回包。
export function loadPlugin(figma) {
  let resolver = null;
  const posts = [];

  figma.ui.postMessage = (message) => {
    posts.push(message);
    if (resolver) {
      const settle = resolver;
      resolver = null;
      settle(message);
    }
  };

  const context = createContext({ figma, __html__: '<html></html>', console });
  const source = readFileSync(resolve(ROOT, 'plugin', 'main.js'), 'utf8');
  runInContext(source, context, { filename: 'plugin/main.js' });

  return {
    figma,
    posts,
    send(message) {
      return new Promise((settle, reject) => {
        const timer = setTimeout(() => {
          resolver = null;
          reject(new Error(`no response for ${message.type}`));
        }, 5000);
        resolver = (value) => {
          clearTimeout(timer);
          settle(value);
        };
        figma.ui.onmessage(message);
      });
    },
  };
}
