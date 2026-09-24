const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function createOverlay() {
  let svg = null;

  function ensure(boardEl) {
    if (svg && svg.parentElement === boardEl) return;
    remove();
    svg = el('svg', { viewBox: '0 0 8 8', class: 'pm-overlay' });
    boardEl.appendChild(svg);
  }

  function center(file, rank, orientation) {
    return orientation === 'black'
      ? [7 - file + 0.5, rank + 0.5]
      : [file + 0.5, 7 - rank + 0.5];
  }

  function draw(boardEl, { uci, san, value }, orientation) {
    ensure(boardEl);
    svg.replaceChildren();
    const [x1, y1] = center(uci.charCodeAt(0) - 97, uci.charCodeAt(1) - 49, orientation);
    const [x2, y2] = center(uci.charCodeAt(2) - 97, uci.charCodeAt(3) - 49, orientation);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    const bx = x2 - ux * 0.35; // base of the arrowhead
    const by = y2 - uy * 0.35;
    svg.append(
      el('line', { x1, y1, x2: bx, y2: by, class: 'pm-arrow-line' }),
      el('polygon', {
        points: `${x2},${y2} ${bx - uy * 0.22},${by + ux * 0.22} ${bx + uy * 0.22},${by - ux * 0.22}`,
        class: 'pm-arrow-head',
      }),
    );
    const label = el('text', {
      x: Math.min(Math.max(x2, 0.8), 7.2),
      y: Math.min(Math.max(y2 - 0.55, 0.35), 7.8),
      'text-anchor': 'middle',
      class: 'pm-label',
    });
    label.textContent = `${san || uci} ${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
    svg.append(label);
  }

  function clear() {
    if (svg) svg.replaceChildren();
  }

  function remove() {
    if (svg) svg.remove();
    svg = null;
  }

  return { draw, clear, remove };
}
