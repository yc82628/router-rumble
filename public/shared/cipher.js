// Cipher reveal: text starts as scrambled glyphs and decodes left to right into the real text.
// Works on any element (keeps its <span>/<small> markup, only the letters change).
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&@$/<>*+=';

export function cipherReveal(el, { duration = 1400, delay = 0 } = {}) {
  if (!el) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push({ node: walker.currentNode, text: walker.currentNode.nodeValue });
  const total = nodes.reduce((n, x) => n + x.text.length, 0);
  if (!total || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim()); // screen readers get the real title
  const start = performance.now() + delay;
  const frame = (now) => {
    const progress = Math.max(0, Math.min(1, (now - start) / duration));
    let revealed = Math.floor(progress * total);
    for (const { node, text } of nodes) {
      let out = '';
      for (const ch of text) {
        if (revealed > 0 || ch === ' ') out += ch;
        else out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        revealed--;
      }
      node.nodeValue = out;
    }
    if (progress < 1) requestAnimationFrame(frame);
    else el.removeAttribute('aria-label');
  };
  requestAnimationFrame(frame);
}
