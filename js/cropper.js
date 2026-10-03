// Image cropper for card art: drag to move, wheel / slider to zoom.
// The frame matches what the card shows (the art window, or the whole card
// for full-art cards), and the result is a compressed image ready to upload.
window.Cropper = (() => {
  const { h } = U;

  // Card art shapes (width / height), matching the card CSS.
  const SHAPES = {
    normal: { aspect: 10 / (14.25 * 0.46), outW: 1000, label: 'Art window' },
    full: { aspect: 10.5 / 14.75, outW: 840, label: 'Full card' },
  };
  const MAX_BYTES = 2 * 1024 * 1024;

  // src: a File, Blob or image URL. Resolves to { file, url } or null if cancelled.
  function open(src, { fullArt = false } = {}) {
    return new Promise(resolve => {
      const shape = fullArt ? SHAPES.full : SHAPES.normal;
      const url = typeof src === 'string' ? src : URL.createObjectURL(src);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onerror = () => { U.toast("That image couldn't be opened for cropping.", 'error'); resolve(null); };
      img.onload = () => build();
      img.src = url;

      function build() {
        const vw = Math.min(fullArt ? 300 : 420, window.innerWidth - 80);
        const vh = Math.round(vw / shape.aspect);
        const minScale = Math.max(vw / img.naturalWidth, vh / img.naturalHeight); // "cover"
        let scale = minScale, x = 0, y = 0;

        const pic = h('img', { src: url, alt: '', draggable: 'false', class: 'crop-img' });
        const view = h('div', { class: 'crop-view' + (fullArt ? ' full' : ''), style: { width: vw + 'px', height: vh + 'px' } },
          pic, h('div', { class: 'crop-guides', 'aria-hidden': 'true' }));
        const zoom = h('input', { id: 'crop-zoom', type: 'range', min: 1, max: 4, step: 0.01, value: 1, 'aria-label': 'Zoom' });

        const clamp = () => {
          const w = img.naturalWidth * scale, hh = img.naturalHeight * scale;
          x = Math.min(0, Math.max(vw - w, x));
          y = Math.min(0, Math.max(vh - hh, y));
        };
        const paint = () => {
          clamp();
          pic.style.width = img.naturalWidth * scale + 'px';
          pic.style.height = img.naturalHeight * scale + 'px';
          pic.style.transform = `translate(${x}px, ${y}px)`;
        };
        // start centered
        x = (vw - img.naturalWidth * scale) / 2;
        y = (vh - img.naturalHeight * scale) / 2;
        paint();

        // zoom around a point in the frame
        const zoomTo = (next, cx = vw / 2, cy = vh / 2) => {
          next = Math.max(minScale, Math.min(minScale * 4, next));
          const ix = (cx - x) / scale, iy = (cy - y) / scale;
          scale = next;
          x = cx - ix * scale;
          y = cy - iy * scale;
          zoom.value = (scale / minScale).toFixed(2);
          paint();
        };
        zoom.addEventListener('input', () => zoomTo(minScale * Number(zoom.value)));
        view.addEventListener('wheel', e => {
          e.preventDefault();
          const r = view.getBoundingClientRect();
          zoomTo(scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });

        // drag (mouse, touch, pen); two fingers pinch to zoom
        const pts = new Map();
        let last = null, pinch = null;
        view.addEventListener('pointerdown', e => {
          view.setPointerCapture(e.pointerId);
          pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
          last = { x: e.clientX, y: e.clientY };
          if (pts.size === 2) {
            const [a, b] = [...pts.values()];
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: scale };
          }
        });
        view.addEventListener('pointermove', e => {
          if (!pts.has(e.pointerId)) return;
          pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pts.size === 2 && pinch) {
            const [a, b] = [...pts.values()];
            const r = view.getBoundingClientRect();
            zoomTo(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
            return;
          }
          x += e.clientX - last.x;
          y += e.clientY - last.y;
          last = { x: e.clientX, y: e.clientY };
          paint();
        });
        const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; const p = [...pts.values()][0]; if (p) last = { ...p }; };
        view.addEventListener('pointerup', up);
        view.addEventListener('pointercancel', up);
        // arrow keys nudge, +/- zoom
        view.tabIndex = 0;
        view.addEventListener('keydown', e => {
          const step = e.shiftKey ? 20 : 5;
          if (e.key === 'ArrowLeft') x += step; else if (e.key === 'ArrowRight') x -= step;
          else if (e.key === 'ArrowUp') y += step; else if (e.key === 'ArrowDown') y -= step;
          else if (e.key === '+' || e.key === '=') return zoomTo(scale * 1.08);
          else if (e.key === '-') return zoomTo(scale / 1.08);
          else return;
          e.preventDefault();
          paint();
        });

        let done = false;
        const finish = async () => {
          done = true;
          const outW = shape.outW, outH = Math.round(outW / shape.aspect);
          const canvas = document.createElement('canvas');
          canvas.width = outW; canvas.height = outH;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          const k = outW / vw; // frame px → output px
          ctx.drawImage(img, x * k, y * k, img.naturalWidth * scale * k, img.naturalHeight * scale * k);
          let blob;
          try {
            for (const [type, q] of [['image/webp', 0.9], ['image/webp', 0.75], ['image/jpeg', 0.85], ['image/jpeg', 0.7]]) {
              blob = await new Promise(r => canvas.toBlob(r, type, q));
              if (blob && blob.size <= MAX_BYTES) break;
            }
          } catch (err) {
            U.toast("This image can't be cropped here (the site hosting it blocks it). Upload the file again instead.", 'error');
            m.close(); resolve(null); return;
          }
          if (!blob) { U.toast('Cropping failed. Try a different image.', 'error'); m.close(); resolve(null); return; }
          const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
          const file = new File([blob], 'card-art.' + ext, { type: blob.type });
          m.close();
          resolve({ file, url: URL.createObjectURL(file) });
        };

        const m = U.modal('Crop card art', h('div', { class: 'crop-wrap' },
          h('p', { class: 'muted' }, `Drag to move, scroll or pinch to zoom. The frame is the ${fullArt ? 'whole card (full art)' : "card's art window"}; for full-art cards, the bottom part sits behind the name and text.`),
          view,
          h('div', { class: 'row crop-zoom' }, h('span', { 'aria-hidden': 'true' }, '−'), zoom, h('span', { 'aria-hidden': 'true' }, '+')),
          h('div', { class: 'row end' },
            h('button', { class: 'btn ghost', on: { click: () => { scale = minScale; zoom.value = 1; x = (vw - img.naturalWidth * scale) / 2; y = (vh - img.naturalHeight * scale) / 2; paint(); } } }, 'Reset'),
            h('button', { class: 'btn primary', on: { click: finish } }, 'Use this crop'))),
          { onClose: () => { if (!done) resolve(null); } });
        view.focus();
      }
    });
  }

  return { open };
})();
