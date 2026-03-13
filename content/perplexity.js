// AI Panel - Perplexity Content Script

(function() {
  'use strict';

  const AI_TYPE = 'perplexity';

  // Check if extension context is still valid
  function isContextValid() {
    return chrome.runtime && chrome.runtime.id;
  }

  // Safe message sender that checks context first
  function safeSendMessage(message, callback) {
    if (!isContextValid()) {
      console.log('[AI Panel] Extension context invalidated, skipping message');
      return;
    }
    try {
      chrome.runtime.sendMessage(message, callback);
    } catch (e) {
      console.log('[AI Panel] Failed to send message:', e.message);
    }
  }

  // Notify background that content script is ready
  safeSendMessage({ type: 'CONTENT_SCRIPT_READY', aiType: AI_TYPE });

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'INJECT_MESSAGE') {
      injectMessage(message.message)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.type === 'INJECT_FILES') {
      console.log('[AI Panel] Perplexity received INJECT_FILES message, files:', message.files?.length);
      injectFiles(message.files)
        .then(() => {
          console.log('[AI Panel] Perplexity injectFiles completed successfully');
          sendResponse({ success: true });
        })
        .catch(err => {
          console.log('[AI Panel] Perplexity injectFiles failed:', err.message);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }

    if (message.type === 'GET_LATEST_RESPONSE') {
      const response = getLatestResponse();
      sendResponse({ content: response });
      return true;
    }
  });

  // Setup response observer for cross-reference feature
  setupResponseObserver();

  async function injectMessage(text) {
    // Perplexity uses a textarea for input
    const inputSelectors = [
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ];

    let inputEl = null;
    for (const selector of inputSelectors) {
      const candidates = document.querySelectorAll(selector);
      for (const el of candidates) {
        if (isVisible(el)) {
          inputEl = el;
          break;
        }
      }
      if (inputEl) break;
    }

    if (!inputEl) {
      throw new Error('Could not find Perplexity input field');
    }

    // Focus the input
    inputEl.focus();

    // Set the value using native setter to trigger React state update
    const proto = Object.getPrototypeOf(inputEl);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(inputEl, text);
    } else {
      inputEl.value = text;
    }

    // Dispatch events to trigger React/framework update
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));

    // Small delay to let the UI process
    await sleep(200);

    // Find and click the send button
    const sendButton = findSendButton();
    if (!sendButton) {
      // Fallback: press Enter
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        bubbles: true
      }));
      console.log('[AI Panel] Perplexity: no send button found, used Enter key');
    } else {
      await waitForButtonEnabled(sendButton);
      sendButton.click();
    }

    console.log('[AI Panel] Perplexity message sent, starting response capture...');
    waitForStreamingComplete();
    return true;
  }

  function findSendButton() {
    const selectors = [
      'button[aria-label*="Submit"]',
      'button[aria-label*="Send"]',
      'button[type="submit"]',
      'button svg[data-icon="arrow-right"]',
      'button svg[data-icon="paper-plane"]'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) {
        return el.closest('button') || el;
      }
    }

    // Fallback: find a button near the textarea
    const buttons = document.querySelectorAll('button');
    for (const btn of [...buttons].reverse()) {
      const rect = btn.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 200 && isVisible(btn) && !btn.disabled) {
        if (btn.querySelector('svg')) {
          return btn;
        }
      }
    }

    return null;
  }

  async function waitForButtonEnabled(button, maxWait = 2000) {
    const start = Date.now();
    while (button.disabled && Date.now() - start < maxWait) {
      await sleep(50);
    }
  }

  function setupResponseObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!isContextValid()) {
        observer.disconnect();
        return;
      }
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              checkForResponse(node);
            }
          }
        }
      }
    });

    const startObserving = () => {
      if (!isContextValid()) return;
      const mainContent = document.querySelector('main') || document.body;
      observer.observe(mainContent, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserving);
    } else {
      startObserving();
    }
  }

  let lastCapturedContent = '';
  let isCapturing = false;

  function checkForResponse(node) {
    if (isCapturing) return;
    // Perplexity response containers
    const isResponse =
      node.matches?.('[data-testid="answer"], .prose, [class*="answer"]') ||
      node.querySelector?.('[data-testid="answer"], .prose, [class*="answer"]');

    if (isResponse) {
      console.log('[AI Panel] Perplexity detected new response, waiting for completion...');
      waitForStreamingComplete();
    }
  }

  async function waitForStreamingComplete() {
    if (isCapturing) {
      console.log('[AI Panel] Perplexity already capturing, skipping...');
      return;
    }
    isCapturing = true;

    let previousContent = '';
    let stableCount = 0;
    const maxWait = 600000; // 10 minutes
    const checkInterval = 500;
    const stableThreshold = 4; // 2 seconds stable
    const startTime = Date.now();

    try {
      while (Date.now() - startTime < maxWait) {
        if (!isContextValid()) {
          console.log('[AI Panel] Context invalidated, stopping capture');
          return;
        }
        await sleep(checkInterval);
        const currentContent = getLatestResponse() || '';
        if (currentContent === previousContent && currentContent.length > 0) {
          stableCount++;
          if (stableCount >= stableThreshold) {
            if (currentContent !== lastCapturedContent) {
              lastCapturedContent = currentContent;
              safeSendMessage({
                type: 'RESPONSE_CAPTURED',
                aiType: AI_TYPE,
                content: currentContent
              });
              console.log('[AI Panel] Perplexity response captured, length:', currentContent.length);
            }
            return;
          }
        } else {
          stableCount = 0;
        }
        previousContent = currentContent;
      }
    } finally {
      isCapturing = false;
    }
  }

  function getLatestResponse() {
    // Try Perplexity-specific answer containers
    const selectors = [
      '[data-testid="answer"]',
      '.prose',
      '[class*="answerContent"]',
      '[class*="answer"]'
    ];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        const last = elements[elements.length - 1];
        const content = last.innerText?.trim();
        if (content && content.length > 10) {
          console.log('[AI Panel] Perplexity response found via', selector, ', length:', content.length);
          return content;
        }
      }
    }

    console.log('[AI Panel] Perplexity: no response found');
    return null;
  }

  // File injection for Perplexity
  async function injectFiles(filesData) {
    console.log('[AI Panel] Perplexity injecting files:', filesData.length);

    const files = filesData.map(fileData => {
      const byteCharacters = atob(fileData.base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: fileData.type });
      return new File([blob], fileData.name, { type: fileData.type });
    });

    const fileInputs = document.querySelectorAll('input[type="file"]');
    console.log('[AI Panel] Perplexity found', fileInputs.length, 'file inputs');

    if (fileInputs.length === 0) {
      const uploadSelectors = [
        'button[aria-label*="Upload"]',
        'button[aria-label*="Attach"]',
        'button[aria-label*="file"]',
        'label[for*="file"]'
      ];
      for (const selector of uploadSelectors) {
        const btn = document.querySelector(selector);
        if (btn && isVisible(btn)) {
          btn.click();
          await sleep(500);
          break;
        }
      }
    }

    const allInputs = document.querySelectorAll('input[type="file"]');
    for (const fileInput of allInputs) {
      try {
        const dataTransfer = new DataTransfer();
        files.forEach(file => dataTransfer.items.add(file));
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        console.log('[AI Panel] Perplexity files set on input');
        await sleep(1000);
        return true;
      } catch (e) {
        console.log('[AI Panel] Perplexity input injection error:', e.message);
      }
    }

    throw new Error('Perplexity 暂不支持自动文件上传，请手动上传文件');
  }

  // Utility functions
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0';
  }

  console.log('[AI Panel] Perplexity content script loaded');
})();
