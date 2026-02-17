// LLM OS SDK — runs INSIDE the iframe sandbox
// Communicates with kernel via postMessage
// This file is injected into every generated app

(function() {
  'use strict';

  const pendingRequests = new Map();
  let requestId = 0;

  // Send a message to the kernel and wait for response
  function kernelCall(type, payload) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      pendingRequests.set(id, { resolve, reject });

      window.parent.postMessage({
        source: 'llmos-app',
        id,
        type,
        payload,
      }, '*');

      // Timeout after 10 seconds
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`Kernel call timeout: ${type}`));
        }
      }, 10000);
    });
  }

  // Listen for kernel responses
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.source !== 'llmos-kernel') return;

    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    pendingRequests.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  });

  // UI namespace
  const ui = {
    // Create a DOM element
    h(tag, props, ...children) {
      const el = document.createElement(tag);

      if (props) {
        for (const [key, value] of Object.entries(props)) {
          if (key === 'style' && typeof value === 'object') {
            Object.assign(el.style, value);
          } else if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(key.slice(2).toLowerCase(), value);
          } else if (key === 'className') {
            el.className = value;
          } else {
            el.setAttribute(key, value);
          }
        }
      }

      for (const child of children.flat(Infinity)) {
        if (child == null || child === false) continue;
        if (typeof child === 'string' || typeof child === 'number') {
          el.appendChild(document.createTextNode(String(child)));
        } else if (child instanceof Node) {
          el.appendChild(child);
        }
      }

      return el;
    },

    // Render an element to the page
    render(element) {
      const root = document.getElementById('llmos-root') || document.body;
      root.innerHTML = '';
      if (element instanceof Node) {
        root.appendChild(element);
      }
    },

    // Show a notification (sends to kernel)
    async notify(message, options = {}) {
      return kernelCall('notify', { message, ...options });
    },

    // Show a confirm dialog
    async confirm(message) {
      return kernelCall('confirm', { message });
    },
  };

  // Storage namespace — proxied through kernel
  const storage = {
    async get(key) {
      return kernelCall('storage:get', { key });
    },

    async set(key, value) {
      return kernelCall('storage:set', { key, value });
    },

    async remove(key) {
      return kernelCall('storage:remove', { key });
    },

    async keys() {
      return kernelCall('storage:keys', {});
    },
  };

  // Timer namespace — runs directly (safe, no capability needed)
  const timer = {
    setTimeout(fn, ms) {
      return window.setTimeout(fn, ms);
    },
    clearTimeout(id) {
      return window.clearTimeout(id);
    },
    setInterval(fn, ms) {
      return window.setInterval(fn, ms);
    },
    clearInterval(id) {
      return window.clearInterval(id);
    },
  };

  // Capabilities namespace
  const caps = {
    async has(capability) {
      return kernelCall('caps:has', { capability });
    },
    async request(capability) {
      return kernelCall('caps:request', { capability });
    },
  };

  // Expose as global
  window.LLMOS = Object.freeze({ ui, storage, timer, caps });
})();
