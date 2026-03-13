// AI Panel - Perplexity Content Script
// Fixed: input injection + send button selector

(function() {
  'use strict';

  const AI_TYPE = 'perplexity';

  function isContextValid() {
    return chrome.runtime && chrome.runtime.id;
  }

  function safeSendMessage(message, callback) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage(message, callback);
    } catch (e) {
      console.log('[AI Panel] Failed to send message:', e.message);
    }
  }

  safeSendMessage({ type: 'CONTENT_SCRIPT_READY', aiType: AI_TYPE });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'INJECT_MESSAGE') {
      injectMessage(message.message)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (message.type === 'INJECT_FILES') {
      injectFiles(message.files)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (message.type === 'GET_LATEST_RESPONSE') {
      sendResponse({ content: getLatestResponse() });
      return true;
    }
  });

  setupResponseObserver();

  // ─── Input Injection ───────────────────────────────────────────────
  async function injectMessage(text) {
    // Perplexity uses a contenteditable div (not a real textarea)
    // The actual editable area is: div[contenteditable="true"] inside the input container
    // We must exclude the "Computer" tool panel which is also contenteditable sometimes

    const inputEl = findInputElement();
    if (!inputEl) throw new Error('Could not find Perplexity input field');

    inputEl.focus();

    // Clear existing content
    inputEl.innerHTML = '';
    await sleep(50);

    // Use execCommand to insert text (works with React contenteditable)
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, text);

    // Fallback: if execCommand didn't work, set directly
    if (!inputEl.textContent.trim()) {
      inputEl.textContent = text;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    await sleep(200);

    const sendButton = findSendButton(inputEl);
    if (!sendButton) {
      // Last resort: press Enter
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
      }));
      console.log('[AI Panel] Perplexity: used Enter key fallback');
    } else {
      await waitForButtonEnabled(sendButton);
      sendButton.click();
      console.log('[AI Panel] Perplexity: clicked send button');
    }

    waitForStreamingComplete();
    return true;
  }

  function findInputElement() {
    // Strategy 1: The main search/chat textarea - Perplexity uses a div[contenteditable]
    // Look for contenteditable that is NOT inside a tool panel
    const allEditable = document.querySelectorAll('div[contenteditable="true"]');
    for (const el of allEditable) {
      if (!isVisible(el)) continue;
      // Skip elements that are tiny (toolbar items etc)
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 20) continue;
      // Skip if it's inside a dropdown/modal that appeared from Computer button
      const isInModal = el.closest('[role="dialog"], [role="menu"], .fixed');
      if (isInModal) continue;
      return el;
    }

    // Strategy 2: textarea (older Perplexity UI)
    const textarea = document.querySelector('textarea');
    if (textarea && isVisible(textarea)) return textarea;

    return null;
  }

  function findSendButton(inputEl) {
    // Strategy 1: aria-label containing submit/send
    const ariaSelectors = [
      'button[aria-label="Submit"]',
      'button[aria-label="submit"]',
      'button[aria-label="Send"]',
      'button[aria-label="send"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="Submit query"]',
    ];
    for (const sel of ariaSelectors) {
      const btn = document.querySelector(sel);
      if (btn && isVisible(btn)) return btn;
    }

    // Strategy 2: find the button INSIDE the same input container as inputEl
    // that has a right-arrow / send SVG icon
    if (inputEl) {
      // Walk up to find the input wrapper
      let container = inputEl.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!container) break;
        const buttons = container.querySelectorAll('button');
        for (const btn of [...buttons].reverse()) {
          if (!isVisible(btn)) continue;
          // Exclude buttons known to NOT be send (Computer, mic, attach, plus)
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (
            label.includes('computer') ||
            label.includes('microphone') ||
            label.includes('mic') ||
            label.includes('attach') ||
            label.includes('upload') ||
            label.includes('model') ||
            label.includes('plus') ||
            label.includes('add')
          ) continue;

          // Prefer buttons with a right-pointing arrow SVG (send icon)
          const svgPath = btn.querySelector('svg path, svg polyline, svg line');
          if (svgPath) return btn;
        }
        container = container.parentElement;
      }
    }

    // Strategy 3: last enabled button near bottom of viewport
    const allButtons = [...document.querySelectorAll('button')];
    const bottomButtons = allButtons.filter(btn => {
      if (!isVisible(btn) || btn.disabled) return false;
      const rect = btn.getBoundingClientRect();
      return rect.bottom > window.innerHeight - 200 && rect.top > 0;
    });

    // Among bottom buttons, prefer the rightmost one that has an SVG and no harmful label
    const candidates = bottomButtons.filter(btn => {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      return (
        !label.includes('computer') &&
        !label.includes('mic') &&
        !label.includes('attach') &&
        !label.includes('model') &&
        btn.querySelector('svg')
      );
    });
    if (candidates.length > 0) {
      // Return rightmost
      return candidates.reduce((a, b) => {
        return a.getBoundingClientRect().right > b.getBoundingClientRect().right ? a : b;
      });
    }

    return null;
  }

  async function waitForButtonEnabled(button, maxWait = 5000) {
    const start = Date.now();
    while (button.disabled && Date.now() - start < maxWait) {
      await sleep(50);
    }
  }

  // ─── Response Observer ─────────────────────────────────────────────
  function setupResponseObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!isContextValid()) { observer.disconnect(); return; }
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) checkForResponse(node);
          }
        }
      }
    });
    const start = () => {
      if (!isContextValid()) return;
      observer.observe(document.querySelector('main') || document.body, {
        childList: true, subtree: true
      });
    };
    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', start)
      : start();
  }

  let lastCapturedContent = '';
  let isCapturing = false;

  function checkForResponse(node) {
    if (isCapturing) return;
    const hit =
      node.matches?.('.prose, [class*="answer"], [data-testid*="answer"]') ||
      node.querySelector?.('.prose, [class*="answer"], [data-testid*="answer"]');
    if (hit) {
      console.log('[AI Panel] Perplexity: new response detected');
      waitForStreamingComplete();
    }
  }

  async function waitForStreamingComplete() {
    if (isCapturing) return;
    isCapturing = true;
    let prev = '';
    let stableCount = 0;
    const start = Date.now();
    try {
      while (Date.now() - start < 600000) {
        if (!isContextValid()) return;
        await sleep(500);
        const cur = getLatestResponse() || '';
        if (cur === prev && cur.length > 0) {
          stableCount++;
          if (stableCount >= 4) {
            if (cur !== lastCapturedContent) {
              lastCapturedContent = cur;
              safeSendMessage({ type: 'RESPONSE_CAPTURED', aiType: AI_TYPE, content: cur });
              console.log('[AI Panel] Perplexity response captured, length:', cur.length);
            }
            return;
          }
        } else {
          stableCount = 0;
        }
        prev = cur;
      }
    } finally {
      isCapturing = false;
    }
  }

  function getLatestResponse() {
    // Perplexity answer selectors (in priority order)
    const selectors = [
      '[data-testid="answer-text"]',
      '[data-testid="answer"]',
      '.prose',
      '[class*="answerContent"]',
      '[class*="answer"]'
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        const last = els[els.length - 1];
        const text = last.innerText?.trim();
        if (text && text.length > 10) return text;
      }
    }
    return null;
  }

  // ─── File Upload ───────────────────────────────────────────────────
  async function injectFiles(filesData) {
    const files = filesData.map(fd => {
      const bytes = atob(fd.base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      return new File([arr], fd.name, { type: fd.type });
    });

    let inputs = document.querySelectorAll('input[type="file"]');
    if (inputs.length === 0) {
      for (const sel of ['button[aria-label*="Attach"]', 'button[aria-label*="Upload"]']) {
        const btn = document.querySelector(sel);
        if (btn && isVisible(btn)) { btn.click(); await sleep(500); break; }
      }
      inputs = document.querySelectorAll('input[type="file"]');
    }
    for (const inp of inputs) {
      try {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1000);
        return true;
      } catch (e) { console.log('[AI Panel] file inject error:', e.message); }
    }
    throw new Error('Perplexity 暂不支持自动文件上传，请手动上传');
  }

  // ─── Utils ─────────────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  console.log('[AI Panel] Perplexity content script loaded (v2)');
})();
