import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { Stage, Layer, Group, Ellipse, Image as KonvaImage, Line, Rect, Text as KonvaText, Transformer } from 'react-konva';
import {
  AlignCenter, AlignHorizontalDistributeCenter, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart, AlignLeft, AlignRight, AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, ArrowLeft, Bold, Check, ChevronDown, ChevronUp,
  Circle, Clipboard, Copy, Crop, Download, Eye, EyeOff, FileImage, GripVertical, ImagePlus,
  Italic, Layers3, LayoutTemplate, Lock, MoreHorizontal, Pencil, Plus, Redo2, RotateCcw,
  Save, Shapes, Sparkles, Square, Star, Strikethrough, Trash2, Type, Underline, Undo2, Unlock, Upload,
  X, ZoomIn, ZoomOut
} from 'lucide-react';
import bundledTemplates from './bundled-templates.json';
import './styles.css';

const browserDesktop = {
  isDesktop: false,
  loadConfig: async () => ({ theme: 'system', autoCopy: true }),
  loadTemplates: async () => JSON.parse(localStorage.getItem('meme-helper-templates') || '[]'),
  saveTemplates: async (value) => localStorage.setItem('meme-helper-templates', JSON.stringify(value)),
  loadEditorDrafts: async () => JSON.parse(localStorage.getItem('meme-helper-editor-drafts') || '{}'),
  saveEditorDrafts: async (value) => localStorage.setItem('meme-helper-editor-drafts', JSON.stringify(value)),
  copyImage: async (dataUrl, clipboardDataUrl) => {
    const blob = await (await fetch(clipboardDataUrl || dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  },
  readClipboardImage: async () => {
    if (!navigator.clipboard?.read) return null;
    try {
      const items = await navigator.clipboard.read();
      const item = items.find((candidate) => candidate.types.some((type) => type.startsWith('image/')));
      const type = item?.types.find((candidate) => candidate.startsWith('image/'));
      if (!item || !type) return null;
      const blob = await item.getType(type);
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('无法读取剪贴板图片'));
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      if (['NotAllowedError', 'NotFoundError'].includes(error?.name)) return null;
      throw error;
    }
  },
  saveImage: async (dataUrl, name) => {
    const a = document.createElement('a'); a.href = dataUrl; a.download = name; a.click(); return name;
  }
};

const desktop = window.__TAURI_INTERNALS__ ? {
  isDesktop: true,
  loadConfig: () => invoke('load_config'),
  loadTemplates: () => invoke('load_templates'),
  saveTemplates: (templates) => invoke('save_templates', { templates }),
  loadEditorDrafts: () => invoke('load_editor_drafts'),
  saveEditorDrafts: (drafts) => invoke('save_editor_drafts', { drafts }),
  copyImage: (dataUrl, clipboardDataUrl) => invoke('copy_image', { dataUrl, clipboardDataUrl }),
  readClipboardImage: () => invoke('read_clipboard_image'),
  saveImage: (dataUrl, suggestedName) => invoke('save_image', { dataUrl, suggestedName })
} : (window.memeDesktop || browserDesktop);

function applyTheme(preference = 'system') {
  const normalized = ['light', 'dark', 'system'].includes(preference) ? preference : 'system';
  const theme = normalized === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : normalized;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = normalized;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1d1e20' : '#f5f4ef');
}

applyTheme('system');

const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));
const shapeOf = (layer) => layer.shape || 'rect';
const wheelZoom = (current, deltaY, min, max) => deltaY === 0
  ? current
  : clamp(Math.round(current * (deltaY < 0 ? 1.1 : .9) * 100) / 100, min, max);

const isTextEditingTarget = (target) => target instanceof HTMLElement && (
  target.isContentEditable
  || ['TEXTAREA', 'SELECT'].includes(target.tagName)
  || (target.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'file', 'hidden'].includes(target.type))
);

function snapLayerPosition(layer, position, template, threshold, excludedIds = [layer.id]) {
  const excluded = new Set(excludedIds);
  const otherLayers = template.layers.filter((item) => !excluded.has(item.id) && item.visible);
  const xTargets = [0, template.width / 2, template.width];
  const yTargets = [0, template.height / 2, template.height];
  otherLayers.forEach((item) => {
    xTargets.push(item.x, item.x + item.width / 2, item.x + item.width);
    yTargets.push(item.y, item.y + item.height / 2, item.y + item.height);
  });

  const findSnap = (value, size, targets) => {
    let best = null;
    for (const offset of [0, size / 2, size]) {
      for (const target of targets) {
        const delta = target - (value + offset);
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
          best = { delta, guide: target };
        }
      }
    }
    return best;
  };

  const findDistributionSnap = (value, size, axis) => {
    const startOf = (item) => axis === 'x' ? item.x : item.y;
    const sizeOf = (item) => axis === 'x' ? item.width : item.height;
    const sorted = [...otherLayers].sort((a, b) => startOf(a) - startOf(b));
    const candidates = [];
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const first = sorted[index];
      const second = sorted[index + 1];
      const firstStart = startOf(first);
      const firstEnd = firstStart + sizeOf(first);
      const secondStart = startOf(second);
      const secondEnd = secondStart + sizeOf(second);
      const existingGap = secondStart - firstEnd;
      if (existingGap >= 0) {
        candidates.push(firstStart - existingGap - size, secondEnd + existingGap);
        if (existingGap >= size) candidates.push(firstEnd + (existingGap - size) / 2);
      }
    }
    return candidates.reduce((best, target) => {
      const delta = target - value;
      return Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))
        ? { delta, guide: target + size / 2 }
        : best;
    }, null);
  };

  const chooseCloser = (alignment, distribution) => !alignment || (distribution && Math.abs(distribution.delta) < Math.abs(alignment.delta)) ? distribution : alignment;
  const xSnap = chooseCloser(findSnap(position.x, layer.width, xTargets), findDistributionSnap(position.x, layer.width, 'x'));
  const ySnap = chooseCloser(findSnap(position.y, layer.height, yTargets), findDistributionSnap(position.y, layer.height, 'y'));
  return {
    x: position.x + (xSnap?.delta || 0),
    y: position.y + (ySnap?.delta || 0),
    guides: [
      ...(xSnap ? [{ axis: 'x', value: xSnap.guide }] : []),
      ...(ySnap ? [{ axis: 'y', value: ySnap.guide }] : [])
    ]
  };
}

function snapCropPosition(layer, placement, position, threshold) {
  const xTargets = [0, (layer.width - placement.width) / 2, layer.width - placement.width];
  const yTargets = [0, (layer.height - placement.height) / 2, layer.height - placement.height];
  const nearest = (value, targets) => targets.reduce((best, target) => {
    const delta = target - value;
    return Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta)) ? { delta, guide: target } : best;
  }, null);
  const xSnap = nearest(position.x, xTargets);
  const ySnap = nearest(position.y, yTargets);
  return {
    x: clamp(position.x + (xSnap?.delta || 0), layer.width - placement.width, 0),
    y: clamp(position.y + (ySnap?.delta || 0), layer.height - placement.height, 0),
    guides: [
      ...(xSnap ? [{ axis: 'x', value: xSnap.guide }] : []),
      ...(ySnap ? [{ axis: 'y', value: ySnap.guide }] : [])
    ]
  };
}

function svgData(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function starterTemplates() {
  const now = Date.now();
  const office = svgData(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#f3efe3"/><rect x="30" y="30" width="740" height="740" rx="18" fill="none" stroke="#1c1b19" stroke-width="12"/><text x="400" y="105" text-anchor="middle" font-family="Arial,sans-serif" font-size="54" font-weight="700" fill="#1c1b19">今天也要努力工作</text><rect x="74" y="590" width="652" height="132" rx="12" fill="#f2c94c"/><text x="400" y="675" text-anchor="middle" font-family="Arial,sans-serif" font-size="48" font-weight="700" fill="#1c1b19">（假装很有精神）</text></svg>`);
  const reaction = svgData(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#171716"/><rect x="26" y="26" width="848" height="548" rx="12" fill="none" stroke="#f8f7f2" stroke-width="8"/><text x="450" y="92" text-anchor="middle" font-family="Arial,sans-serif" font-size="48" font-weight="700" fill="#fff">当我看到群里的新需求</text><text x="450" y="548" text-anchor="middle" font-family="Arial,sans-serif" font-size="42" font-weight="700" fill="#f2c94c">先保持微笑</text></svg>`);
  return [
    { id: uid(), name: '上班状态', width: 800, height: 800, createdAt: now, updatedAt: now, layers: [
      { id: uid(), name: '底图与文字', type: 'static', src: office, x: 0, y: 0, width: 800, height: 800, rotation: 0, visible: true, fit: 'fill' },
      { id: uid(), name: '人物照片', type: 'slot', src: '', x: 116, y: 150, width: 568, height: 400, rotation: 0, visible: true, fit: 'cover' }
    ]},
    { id: uid(), name: '需求来了', width: 900, height: 600, createdAt: now, updatedAt: now, layers: [
      { id: uid(), name: '黑色边框', type: 'static', src: reaction, x: 0, y: 0, width: 900, height: 600, rotation: 0, visible: true, fit: 'fill' },
      { id: uid(), name: '反应照片', type: 'slot', src: '', x: 92, y: 125, width: 716, height: 350, rotation: 0, visible: true, fit: 'cover' }
    ]}
  ];
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith('image/')) return reject(new Error('请选择图片文件'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function getCoverCrop(image, boxWidth, boxHeight) {
  const imageRatio = image.width / image.height;
  const boxRatio = boxWidth / boxHeight;
  if (imageRatio > boxRatio) {
    const width = image.height * boxRatio;
    return { x: (image.width - width) / 2, y: 0, width, height: image.height };
  }
  const height = image.width / boxRatio;
  return { x: 0, y: (image.height - height) / 2, width: image.width, height };
}

function getPhotoPlacement(image, layer, transform = {}) {
  const zoom = clamp(transform.zoom || 1, 1, 5);
  const baseScaleX = layer.fit === 'cover' ? Math.max(layer.width / image.width, layer.height / image.height) : layer.width / image.width;
  const baseScaleY = layer.fit === 'cover' ? baseScaleX : layer.height / image.height;
  const width = image.width * baseScaleX * zoom;
  const height = image.height * baseScaleY * zoom;
  const centeredX = (layer.width - width) / 2;
  const centeredY = (layer.height - height) / 2;
  return {
    x: clamp(centeredX + (transform.offsetX || 0), layer.width - width, 0),
    y: clamp(centeredY + (transform.offsetY || 0), layer.height - height, 0),
    width,
    height,
    centeredX,
    centeredY,
    zoom
  };
}

function traceLayerShape(ctx, layer) {
  const width = layer.width;
  const height = layer.height;
  const shape = shapeOf(layer);
  ctx.beginPath();
  if (shape === 'circle') {
    const k = .5522847498;
    const rx = width / 2; const ry = height / 2;
    ctx.moveTo(rx, 0);
    ctx.bezierCurveTo(rx + rx * k, 0, width, ry - ry * k, width, ry);
    ctx.bezierCurveTo(width, ry + ry * k, rx + rx * k, height, rx, height);
    ctx.bezierCurveTo(rx - rx * k, height, 0, ry + ry * k, 0, ry);
    ctx.bezierCurveTo(0, ry - ry * k, rx - rx * k, 0, rx, 0);
  } else if (shape === 'rounded') {
    const radius = Math.min(36, width / 4, height / 4);
    ctx.moveTo(radius, 0); ctx.lineTo(width - radius, 0);
    ctx.quadraticCurveTo(width, 0, width, radius); ctx.lineTo(width, height - radius);
    ctx.quadraticCurveTo(width, height, width - radius, height); ctx.lineTo(radius, height);
    ctx.quadraticCurveTo(0, height, 0, height - radius); ctx.lineTo(0, radius);
    ctx.quadraticCurveTo(0, 0, radius, 0);
  } else {
    ctx.rect(0, 0, width, height);
  }
  ctx.closePath();
}

function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text || '').split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let line = '';
    for (const character of paragraph) {
      const candidate = line + character;
      if (line && ctx.measureText(candidate).width > maxWidth) { lines.push(line); line = character; }
      else line = candidate;
    }
    lines.push(line);
  }
  return lines;
}

function resolveTextFontSize(layer) {
  const requested = clamp(layer.fontSize || 48, 8, 400);
  if (!layer.autoFit) return requested;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontTokens = String(layer.fontStyle || '').split(' ');
  const fontPrefix = `${fontTokens.includes('italic') ? 'italic ' : ''}${fontTokens.includes('bold') ? 'bold ' : ''}`;
  const fontFamily = layer.fontFamily || 'Microsoft YaHei';
  const padding = Math.max(0, Number(layer.backgroundPadding) || 0);
  const availableWidth = Math.max(1, layer.width - padding * 2);
  const availableHeight = Math.max(1, layer.height - padding * 2);
  for (let size = requested; size >= 8; size -= 1) {
    ctx.font = `${fontPrefix}${size}px "${fontFamily}"`;
    const lines = wrapCanvasText(ctx, layer.text, availableWidth);
    if (lines.length * size * (layer.lineHeight || 1.25) <= availableHeight) return size;
  }
  return 8;
}

function drawTextLayer(ctx, layer) {
  const fontSize = resolveTextFontSize(layer);
  const fontTokens = String(layer.fontStyle || '').split(' ');
  const fontStyle = `${fontTokens.includes('italic') ? 'italic ' : ''}${fontTokens.includes('bold') ? 'bold ' : ''}`;
  const fontFamily = layer.fontFamily || 'Microsoft YaHei';
  ctx.font = `${fontStyle}${fontSize}px "${fontFamily}"`;
  ctx.fillStyle = layer.fill || '#22211f';
  ctx.textBaseline = 'top';
  ctx.textAlign = layer.align || 'left';
  const padding = Math.max(0, Number(layer.backgroundPadding) || 0);
  if (layer.background) {
    ctx.save();
    ctx.fillStyle = layer.background;
    ctx.fillRect(0, 0, layer.width, layer.height);
    ctx.restore();
  }
  const availableWidth = Math.max(1, layer.width - padding * 2);
  const lines = wrapCanvasText(ctx, layer.text, availableWidth);
  const lineHeight = fontSize * (layer.lineHeight || 1.25);
  const anchorX = layer.align === 'center' ? layer.width / 2 : layer.align === 'right' ? layer.width - padding : padding;
  const decorations = String(layer.textDecoration || '').split(' ');
  lines.forEach((line, index) => {
    const y = padding + index * lineHeight;
    if (y + fontSize > layer.height) return;
    if (layer.shadowEnabled) {
      ctx.shadowColor = layer.shadowColor || '#000000';
      ctx.shadowBlur = Math.max(0, Number(layer.shadowBlur) || 0);
      ctx.shadowOffsetX = Number(layer.shadowOffsetX) || 0;
      ctx.shadowOffsetY = Number(layer.shadowOffsetY) || 0;
    }
    if ((Number(layer.strokeWidth) || 0) > 0) {
      ctx.strokeStyle = layer.stroke || '#ffffff';
      ctx.lineWidth = Number(layer.strokeWidth) * 2;
      ctx.lineJoin = 'round';
      ctx.strokeText(line, anchorX, y, availableWidth);
    }
    ctx.fillText(line, anchorX, y, availableWidth);
    ctx.shadowColor = 'transparent';
    const metrics = ctx.measureText(line);
    const startX = layer.align === 'center' ? anchorX - metrics.width / 2 : layer.align === 'right' ? anchorX - metrics.width : anchorX;
    ctx.strokeStyle = layer.fill || '#22211f'; ctx.lineWidth = Math.max(1, fontSize / 18);
    if (decorations.includes('underline')) { ctx.beginPath(); ctx.moveTo(startX, y + fontSize * 1.05); ctx.lineTo(startX + metrics.width, y + fontSize * 1.05); ctx.stroke(); }
    if (decorations.includes('line-through')) { ctx.beginPath(); ctx.moveTo(startX, y + fontSize * .55); ctx.lineTo(startX + metrics.width, y + fontSize * .55); ctx.stroke(); }
  });
}

async function renderTemplate(template, replacements, photoTransforms = {}, options = {}) {
  const scale = typeof options === 'number' ? options : clamp(options.scale || 1, 1, 4);
  const mime = typeof options === 'object' ? options.mime || 'image/png' : 'image/png';
  const transparent = typeof options === 'object' && options.transparent && mime !== 'image/jpeg';
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(template.width * scale);
  canvas.height = Math.round(template.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  if (!transparent) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, template.width, template.height);
  }
  for (const layer of template.layers) {
    if (!layer.visible) continue;
    ctx.save();
    ctx.translate(layer.x, layer.y);
    ctx.rotate((layer.rotation || 0) * Math.PI / 180);
    if (layer.type === 'text') {
      drawTextLayer(ctx, layer);
      ctx.restore();
      continue;
    }
    const replacement = typeof replacements === 'string' ? replacements : replacements?.[layer.id];
    const src = layer.type === 'slot' && replacement ? replacement : layer.src;
    if (layer.type === 'slot') { traceLayerShape(ctx, layer); ctx.clip(); }
    if (!src) {
      ctx.fillStyle = '#e8e6df';
      traceLayerShape(ctx, layer); ctx.fill();
      ctx.strokeStyle = '#9d9b94'; ctx.lineWidth = 3; ctx.setLineDash([10, 8]);
      traceLayerShape(ctx, layer); ctx.stroke();
      ctx.restore();
      continue;
    }
    try {
      const image = await loadImage(src);
      if (layer.type === 'slot' && replacement) {
        const placement = getPhotoPlacement(image, layer, photoTransforms[layer.id]);
        ctx.drawImage(image, 0, 0, image.width, image.height, placement.x, placement.y, placement.width, placement.height);
      } else if (layer.fit === 'cover') {
        const crop = getCoverCrop(image, layer.width, layer.height);
        ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, layer.width, layer.height);
      } else {
        ctx.drawImage(image, 0, 0, layer.width, layer.height);
      }
    } finally { ctx.restore(); }
  }
  return canvas.toDataURL(mime, mime === 'image/jpeg' ? .92 : undefined);
}

function useHtmlImage(src) {
  const [image, setImage] = useState(null);
  useEffect(() => {
    if (!src) { setImage(null); return; }
    let alive = true; const img = new Image();
    img.onload = () => alive && setImage(img); img.src = src;
    return () => { alive = false; };
  }, [src]);
  return image;
}

function useUndoState(initializer, limit = 50) {
  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const stateRef = useRef();
  const [counts, setCounts] = useState({ past: 0, future: 0 });
  const [state, setState] = useState(() => {
    const initial = typeof initializer === 'function' ? initializer() : initializer;
    stateRef.current = initial;
    return initial;
  });

  const commit = useCallback((updater) => {
    const previous = stateRef.current;
    const next = typeof updater === 'function' ? updater(previous) : updater;
    if (Object.is(previous, next)) return;
    pastRef.current = [...pastRef.current.slice(-(limit - 1)), previous];
    futureRef.current = [];
    stateRef.current = next;
    setState(next);
    setCounts({ past: pastRef.current.length, future: 0 });
  }, [limit]);

  const undo = useCallback(() => {
    const previous = pastRef.current.pop();
    if (!previous) return false;
    futureRef.current = [...futureRef.current, stateRef.current];
    stateRef.current = previous;
    setState(previous);
    setCounts({ past: pastRef.current.length, future: futureRef.current.length });
    return true;
  }, []);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return false;
    pastRef.current = [...pastRef.current.slice(-(limit - 1)), stateRef.current];
    stateRef.current = next;
    setState(next);
    setCounts({ past: pastRef.current.length, future: futureRef.current.length });
    return true;
  }, [limit]);

  return [state, commit, undo, counts.past > 0, redo, counts.future > 0];
}

function useCanvasViewport(initialZoom, minZoom, maxZoom) {
  const [zoom, setZoomState] = useState(initialZoom);
  const [pan, setPanState] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const zoomRef = useRef(initialZoom);
  const panRef = useRef(pan);
  const stopPanRef = useRef(null);

  const setZoom = useCallback((updater) => {
    const current = zoomRef.current;
    const requested = typeof updater === 'function' ? updater(current) : updater;
    const next = clamp(requested, minZoom, maxZoom);
    zoomRef.current = next;
    setZoomState(next);
  }, [maxZoom, minZoom]);

  const setPan = useCallback((next) => {
    panRef.current = next;
    setPanState(next);
  }, []);

  const zoomAtPointer = useCallback((event) => {
    event.preventDefault();
    // A wheel gesture starts a new viewport operation; never keep a prior
    // blank-area pan gesture alive while the canvas is being rescaled.
    stopPanRef.current?.();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2
    };
    const current = zoomRef.current;
    const next = wheelZoom(current, event.deltaY, minZoom, maxZoom);
    if (next === current) return;
    const previousPan = panRef.current;
    setPan({
      x: pointer.x - (pointer.x - previousPan.x) * next / current,
      y: pointer.y - (pointer.y - previousPan.y) * next / current
    });
    zoomRef.current = next;
    setZoomState(next);
  }, [maxZoom, minZoom, setPan]);

  const beginPan = useCallback((event) => {
    const source = event.evt || event.nativeEvent || event;
    if (source.button !== 0) return;
    source.preventDefault();
    stopPanRef.current?.();
    const start = { x: source.clientX, y: source.clientY };
    const origin = panRef.current;
    const move = (moveEvent) => {
      setPan({
        x: origin.x + moveEvent.clientX - start.x,
        y: origin.y + moveEvent.clientY - start.y
      });
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      stopPanRef.current = null;
      setPanning(false);
    };
    stopPanRef.current = stop;
    setPanning(true);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  }, [setPan]);

  useEffect(() => () => stopPanRef.current?.(), []);

  return { zoom, pan, panning, setZoom, zoomAtPointer, beginPan };
}

function IconButton({ label, children, className = '', ...props }) {
  return <button className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}

function Toast({ toast }) {
  return <div className={`toast ${toast?.kind || ''} ${toast ? 'show' : ''}`}><Check size={18}/><span>{toast?.message}</span></div>;
}

function App() {
  const [templates, setTemplates] = useState([]);
  const [editorDrafts, setEditorDrafts] = useState({});
  const [config, setConfig] = useState({ theme: 'system', autoCopy: true });
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState({ name: 'library' });
  const [toast, setToast] = useState(null);
  const [query, setQuery] = useState('');
  const toastTimer = useRef();
  const editorDraftsRef = useRef({});
  const draftSaveQueue = useRef(Promise.resolve());

  const notify = useCallback((message, kind = '') => {
    clearTimeout(toastTimer.current); setToast({ message, kind });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    Promise.all([desktop.loadTemplates(), desktop.loadConfig(), desktop.loadEditorDrafts()]).then(([saved, loadedConfig, savedDrafts]) => {
      const localTemplates = Array.isArray(saved) ? saved : [];
      const builtInTemplates = bundledTemplates.length ? structuredClone(bundledTemplates) : starterTemplates();
      const merged = localTemplates.length ? [...localTemplates, ...builtInTemplates] : builtInTemplates;
      const next = merged.filter((item, index) => merged.findIndex((candidate) => candidate.id === item.id || (candidate.name === item.name && candidate.width === item.width && candidate.height === item.height)) === index);
      const drafts = savedDrafts && typeof savedDrafts === 'object' && !Array.isArray(savedDrafts) ? savedDrafts : {};
      applyTheme(loadedConfig?.theme);
      editorDraftsRef.current = drafts;
      setEditorDrafts(drafts); setTemplates(next); setConfig((previous) => ({ ...previous, ...(loadedConfig || {}) })); setReady(true);
      if (next.length !== localTemplates.length) desktop.saveTemplates(next);
    }).catch((error) => {
      console.error(error);
      setTemplates(bundledTemplates.length ? structuredClone(bundledTemplates) : starterTemplates());
      setReady(true);
    });
  }, []);

  useEffect(() => {
    applyTheme(config.theme);
    if (config.theme !== 'system') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme('system');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [config.theme]);

  const commitTemplates = async (next) => {
    setTemplates(next); await desktop.saveTemplates(next);
  };

  const persistEditorDrafts = useCallback((next) => {
    editorDraftsRef.current = next;
    setEditorDrafts(next);
    draftSaveQueue.current = draftSaveQueue.current
      .catch(() => undefined)
      .then(() => desktop.saveEditorDrafts(next));
    return draftSaveQueue.current;
  }, []);

  const saveEditorDraft = useCallback((key, value) => persistEditorDrafts({ ...editorDraftsRef.current, [key]: value }), [persistEditorDrafts]);
  const clearEditorDraft = useCallback((key) => {
    const next = { ...editorDraftsRef.current };
    delete next[key];
    return persistEditorDrafts(next);
  }, [persistEditorDrafts]);

  const saveTemplate = async (template) => {
    const existing = templates.some((item) => item.id === template.id);
    const next = existing ? templates.map((item) => item.id === template.id ? template : item) : [template, ...templates];
    await commitTemplates(next); setPage({ name: 'library' }); notify('模板已保存');
  };

  const deleteTemplate = async (id) => {
    if (!confirm('确定删除这个模板吗？此操作不可撤销。')) return;
    await commitTemplates(templates.filter((item) => item.id !== id)); notify('模板已删除');
  };

  const useTemplate = async (template, file) => {
    const nextTemplate = { ...template, lastUsedAt: Date.now() };
    const next = templates.map((item) => item.id === template.id ? nextTemplate : item);
    setTemplates(next);
    desktop.saveTemplates(next).catch(() => undefined);
    setPage({ name: 'use', template: nextTemplate, file });
  };

  const toggleFavorite = async (id) => {
    const next = templates.map((item) => item.id === id ? { ...item, favorite: !item.favorite } : item);
    await commitTemplates(next);
  };

  const renameTemplate = async (id, name) => {
    const nextName = name.trim();
    if (!nextName) {
      notify('模板名称不能为空', 'error');
      return false;
    }
    if (templates.some((item) => item.id !== id && item.name.trim().toLocaleLowerCase() === nextName.toLocaleLowerCase())) {
      notify('已有同名模板，请使用其他名称', 'error');
      return false;
    }
    const current = templates.find((item) => item.id === id);
    if (!current || current.name === nextName) return true;
    try {
      const next = templates.map((item) => item.id === id ? { ...item, name: nextName, updatedAt: Date.now() } : item);
      await commitTemplates(next);
      notify('模板名称已更新');
      return true;
    } catch (error) {
      notify(`模板名称保存失败：${error?.message || error}`, 'error');
      return false;
    }
  };

  if (!ready) return <div className="loading-screen"><Sparkles size={26}/><span>正在准备模板库...</span></div>;

  return <div className="app-shell">
    {page.name === 'library' && <Library templates={templates} query={query} setQuery={setQuery} onCreate={() => setPage({ name: 'editor' })} onEdit={(template) => setPage({ name: 'editor', template })} onRename={renameTemplate} onUse={useTemplate} onDelete={deleteTemplate} onToggleFavorite={toggleFavorite} notify={notify}/>}
    {page.name === 'editor' && <Editor initial={page.template} autosave={editorDrafts[page.template?.id || 'new']} onSaveDraft={saveEditorDraft} onClearDraft={clearEditorDraft} onBack={() => setPage({ name: 'library' })} onSave={saveTemplate} notify={notify}/>}
    {page.name === 'use' && <UseTemplate template={page.template} initialFile={page.file} autoCopy={config.autoCopy !== false} onBack={() => setPage({ name: 'library' })} onEdit={() => setPage({ name: 'editor', template: page.template })} notify={notify}/>}
    <Toast toast={toast}/>
  </div>;
}

function Brand() {
  return <div className="brand"><div className="brand-mark"><Sparkles size={20}/></div><span>MemeHelper</span></div>;
}

function Library({ templates, query, setQuery, onCreate, onEdit, onRename, onUse, onDelete, onToggleFavorite, notify }) {
  const [sort, setSort] = useState('recent');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = templates
    .filter((item) => !favoritesOnly || item.favorite)
    .filter((item) => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery) || (item.tags || []).some((tag) => tag.toLowerCase().includes(normalizedQuery)))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'created' ? (b.createdAt || 0) - (a.createdAt || 0) : (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0));
  return <main className="library-page">
    <header className="topbar"><Brand/><div className="topbar-actions"><span className="storage-note">{desktop.isDesktop ? '模板保存在程序目录的 meme 文件夹' : '模板保存在浏览器'}</span><button className="primary-button" onClick={onCreate}><Plus size={18}/>新建模板</button></div></header>
    <section className="library-heading"><div><p className="eyebrow">模板工作台</p><h1>选择一个模板，马上开始</h1><p>点击使用，或把图片直接拖到模板上。</p></div><div className="library-controls"><div className="search-box"><LayoutTemplate size={18}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称或标签"/></div><button className={`favorite-filter ${favoritesOnly ? 'active' : ''}`} onClick={() => setFavoritesOnly((current) => !current)}><Star size={16} fill={favoritesOnly ? 'currentColor' : 'none'}/>收藏</button><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="模板排序"><option value="recent">最近使用</option><option value="created">最近创建</option><option value="name">按名称</option></select></div></section>
    <section className="template-grid">
      <button className="new-template-card" onClick={onCreate}><span className="new-icon"><Plus size={26}/></span><strong>创建新模板</strong><small>设置底图与照片位置</small></button>
      {filtered.map((template) => <TemplateCard key={template.id} template={template} onUse={onUse} onEdit={onEdit} onRename={onRename} onDelete={onDelete} onToggleFavorite={onToggleFavorite} notify={notify}/>) }
    </section>
    {!filtered.length && <div className="empty-state"><LayoutTemplate size={34}/><h3>没有找到模板</h3><p>换个关键词，或新建一个模板。</p></div>}
    <footer className="app-footer"><span>{templates.length} 个模板</span><span>拖入图片即可生成并复制</span></footer>
  </main>;
}

function RenameTemplateDialog({ template, onCancel, onSave }) {
  const [name, setName] = useState(template.name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef();
  const nextName = name.trim();
  useEffect(() => { inputRef.current?.select(); }, []);
  const submit = async (event) => {
    event.preventDefault();
    if (!nextName || saving) return;
    setSaving(true);
    const saved = await onSave(template.id, nextName);
    setSaving(false);
    if (saved) onCancel();
  };
  return <div className="rename-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-dialog-title" onSubmit={submit} onKeyDown={(event) => { if (event.key === 'Escape' && !saving) onCancel(); }}>
      <div className="rename-dialog-heading"><div><p className="eyebrow">模板操作</p><h2 id="rename-dialog-title">编辑名称</h2></div><IconButton type="button" label="关闭" onClick={onCancel} disabled={saving}><X size={18}/></IconButton></div>
      <label className="rename-dialog-field"><span>模板名称</span><input ref={inputRef} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      <div className="rename-dialog-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>取消</button><button type="submit" className="primary-button" disabled={!nextName || nextName === template.name || saving}><Save size={16}/>{saving ? '保存中' : '保存'}</button></div>
    </form>
  </div>;
}

function TemplateCard({ template, onUse, onEdit, onRename, onDelete, onToggleFavorite, notify }) {
  const [preview, setPreview] = useState('');
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [pasteMenu, setPasteMenu] = useState(null);
  const [quickWorking, setQuickWorking] = useState(false);
  const menuRef = useRef();
  const pasteMenuRef = useRef();
  const slots = useMemo(() => template.layers.filter((layer) => layer.type === 'slot'), [template.layers]);
  const canQuickReplace = slots.length === 1;
  useEffect(() => { let alive = true; renderTemplate(template).then((data) => alive && setPreview(data)); return () => { alive = false; }; }, [template]);
  useEffect(() => {
    if (!menu && !pasteMenu) return undefined;
    const closeMenu = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenu(false);
      if (!pasteMenuRef.current?.contains(event.target)) setPasteMenu(null);
    };
    window.addEventListener('pointerdown', closeMenu);
    return () => window.removeEventListener('pointerdown', closeMenu);
  }, [menu, pasteMenu]);
  const quickReplace = useCallback(async (source) => {
    if (!canQuickReplace || quickWorking) return;
    setQuickWorking(true);
    try {
      const dataUrl = await renderTemplate(template, { [slots[0].id]: source });
      await desktop.copyImage(dataUrl);
      notify('作品已生成并复制到剪贴板');
    } catch (error) {
      notify(`生成或复制失败：${error?.message || error}`, 'error');
    } finally {
      setQuickWorking(false);
    }
  }, [canQuickReplace, notify, quickWorking, slots, template]);
  const pasteImage = useCallback(async () => {
    setPasteMenu(null);
    try {
      const dataUrl = await desktop.readClipboardImage();
      if (!dataUrl) return notify('剪贴板中没有图片', 'error');
      await quickReplace(dataUrl);
    } catch (error) {
      notify(`读取剪贴板失败：${error?.message || error}`, 'error');
    }
  }, [notify, quickReplace]);
  const drop = async (event) => {
    event.preventDefault(); setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file?.type?.startsWith('image/')) return notify('请拖入图片文件', 'error');
    if (canQuickReplace) {
      try { await quickReplace(await fileToDataUrl(file)); }
      catch (error) { notify(`读取图片失败：${error?.message || error}`, 'error'); }
      return;
    }
    onUse(template, file);
  };
  const openPasteMenu = (event) => {
    if (!canQuickReplace) return;
    event.preventDefault();
    event.stopPropagation();
    setMenu(false);
    setPasteMenu({ x: Math.min(event.clientX, window.innerWidth - 196), y: Math.min(event.clientY, window.innerHeight - 52) });
  };
  return <><article className={`template-card ${dragging ? 'dragging' : ''}`} onContextMenu={openPasteMenu} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
    <div className="template-preview" onClick={() => onUse(template)}><span className="slot-count-badge" title="可替换图层数，为1时可以直接拖入图层复制作品到粘贴板" aria-label={`可替换图层数 ${slots.length}`}>{slots.length}</span>{preview && <img src={preview} alt="" draggable={false}/>}<div className="drop-hint"><Upload size={28}/><strong>{canQuickReplace ? '松开并复制作品' : '松开即可生成'}</strong></div></div>
    <div className="template-meta"><div><h3>{template.name}</h3><span>{template.width} x {template.height} · {slots.length} 个照片位</span>{Boolean(template.tags?.length) && <span className="template-tags">{template.tags.slice(0, 3).map((tag) => <small key={tag}>{tag}</small>)}</span>}</div><div className="template-card-tools"><IconButton label={template.favorite ? '取消收藏' : '收藏模板'} className={template.favorite ? 'favorite-active' : ''} onClick={() => onToggleFavorite(template.id)}><Star size={17} fill={template.favorite ? 'currentColor' : 'none'}/></IconButton><div ref={menuRef} className="card-menu-wrap"><IconButton label="模板操作" onClick={() => setMenu((current) => !current)}><MoreHorizontal size={19}/></IconButton>{menu && <div className="context-menu"><button onClick={() => { setMenu(false); onEdit(template); }}><Pencil size={16}/>编辑模板</button><button onClick={() => { setMenu(false); setRenaming(true); }}><Type size={16}/>编辑名称</button><button className="danger" onClick={() => { setMenu(false); onDelete(template.id); }}><Trash2 size={16}/>删除模板</button></div>}</div></div></div>
    <div className="card-actions"><button className="secondary-button" onClick={() => onEdit(template)}><Pencil size={16}/>编辑</button><button className="primary-button grow" onClick={() => onUse(template)}><Sparkles size={17}/>使用模板</button></div>
  </article>{pasteMenu && <div ref={pasteMenuRef} className="library-paste-menu" style={{ left: pasteMenu.x, top: pasteMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button onClick={pasteImage} disabled={quickWorking}><Clipboard size={16}/>粘贴图片并复制作品</button></div>}{renaming && <RenameTemplateDialog template={template} onCancel={() => setRenaming(false)} onSave={onRename}/>}</>;
}

function Editor({ initial, autosave, onSaveDraft, onClearDraft, onBack, onSave, notify }) {
  const draftKey = initial?.id || 'new';
  const initialStateRef = useRef();
  if (!initialStateRef.current) {
    const canRestore = autosave?.draft?.layers && (initial ? autosave.draft.id === initial.id && autosave.savedAt > (initial.updatedAt || 0) : autosave.kind === 'new');
    initialStateRef.current = {
      restored: Boolean(canRestore),
      draft: canRestore ? structuredClone(autosave.draft) : initial ? structuredClone(initial) : { id: uid(), name: '未命名模板', width: 800, height: 800, createdAt: Date.now(), updatedAt: Date.now(), layers: [] }
    };
  }
  const [draft, commitDraft, undo, canUndo, redo, canRedo] = useUndoState(() => initialStateRef.current.draft);
  const [selectedIds, setSelectedIds] = useState(() => draft.layers.at(-1)?.id ? [draft.layers.at(-1).id] : []);
  const selectedId = selectedIds.at(-1) || null;
  const { zoom, pan, panning, setZoom, zoomAtPointer, beginPan } = useCanvasViewport(.72, .2, 1.3);
  const [dirty, setDirty] = useState(initialStateRef.current.restored);
  const [autosaveState, setAutosaveState] = useState(initialStateRef.current.restored ? 'saved' : 'idle');
  const [shapeMenu, setShapeMenu] = useState(false);
  const [layerMenu, setLayerMenu] = useState(null);
  const [draggedLayerId, setDraggedLayerId] = useState(null);
  const [layerDrop, setLayerDrop] = useState(null);
  const [tagsText, setTagsText] = useState(() => (initialStateRef.current.draft.tags || []).join(', '));
  const memeInput = useRef();
  const clipboardLayersRef = useRef([]);
  const layerReorderRef = useRef(null);
  const selected = draft.layers.find((item) => item.id === selectedId);
  const selectedLayers = draft.layers.filter((item) => selectedIds.includes(item.id));
  const selectedGroupId = selectedLayers.length && selectedLayers.every((item) => item.groupId && item.groupId === selectedLayers[0].groupId) ? selectedLayers[0].groupId : null;
  const updateDraft = useCallback((updater) => { commitDraft(updater); setDirty(true); setAutosaveState('pending'); }, [commitDraft]);
  const updateLayer = (id, patch) => updateDraft((prev) => ({ ...prev, layers: prev.layers.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const updateLayers = useCallback((patches) => updateDraft((previous) => ({
    ...previous,
    layers: previous.layers.map((layer) => patches[layer.id] ? { ...layer, ...patches[layer.id] } : layer)
  })), [updateDraft]);
  const undoDraft = useCallback(() => { if (undo()) { setDirty(true); setAutosaveState('pending'); } }, [undo]);
  const redoDraft = useCallback(() => { if (redo()) { setDirty(true); setAutosaveState('pending'); } }, [redo]);
  const selectLayer = useCallback((id, event = {}) => {
    const layer = draft.layers.find((item) => item.id === id);
    if (!layer) return;
    const groupIds = layer.groupId ? draft.layers.filter((item) => item.groupId === layer.groupId).map((item) => item.id) : [id];
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    setSelectedIds((current) => {
      if (!additive) return groupIds;
      const allSelected = groupIds.every((item) => current.includes(item));
      return allSelected ? current.filter((item) => !groupIds.includes(item)) : [...new Set([...current, ...groupIds])];
    });
  }, [draft.layers]);
  const copySelectedLayers = useCallback(() => {
    const layers = draft.layers.filter((item) => selectedIds.includes(item.id));
    if (!layers.length) return;
    clipboardLayersRef.current = structuredClone(layers);
    notify(layers.length === 1 ? `已复制图层“${layers[0].name}”` : `已复制 ${layers.length} 个图层`);
  }, [draft.layers, notify, selectedIds]);
  const pasteLayers = useCallback(() => {
    if (!clipboardLayersRef.current.length) return notify('请先选择并复制图层', 'error');
    const groupMap = new Map();
    const layers = clipboardLayersRef.current.map((copiedLayer) => {
      if (copiedLayer.groupId && !groupMap.has(copiedLayer.groupId)) groupMap.set(copiedLayer.groupId, uid());
      return {
        ...structuredClone(copiedLayer),
        id: uid(),
        groupId: copiedLayer.groupId ? groupMap.get(copiedLayer.groupId) : undefined,
        name: `${copiedLayer.name} 副本`,
        x: clamp(copiedLayer.x + 20, 0, Math.max(0, draft.width - copiedLayer.width)),
        y: clamp(copiedLayer.y + 20, 0, Math.max(0, draft.height - copiedLayer.height))
      };
    });
    updateDraft((previous) => ({ ...previous, layers: [...previous.layers, ...layers] }));
    clipboardLayersRef.current = structuredClone(layers);
    setSelectedIds(layers.map((layer) => layer.id));
  }, [draft.height, draft.width, notify, updateDraft]);
  const removeSelectedLayers = useCallback(() => {
    const removableIds = draft.layers.filter((layer) => selectedIds.includes(layer.id) && !layer.locked).map((layer) => layer.id);
    if (!removableIds.length) return notify('所选图层已锁定', 'error');
    updateDraft((previous) => ({ ...previous, layers: previous.layers.filter((layer) => !removableIds.includes(layer.id)) }));
    setSelectedIds((current) => current.filter((id) => !removableIds.includes(id)));
  }, [draft.layers, notify, selectedIds, updateDraft]);
  const nudgeSelectedLayers = useCallback((key, distance) => {
    const requestedX = key === 'ArrowLeft' ? -distance : key === 'ArrowRight' ? distance : 0;
    const requestedY = key === 'ArrowUp' ? -distance : key === 'ArrowDown' ? distance : 0;
    updateDraft((previous) => {
      const selectedUnlocked = previous.layers.filter((layer) => selectedIds.includes(layer.id) && !layer.locked);
      if (!selectedUnlocked.length) return previous;
      const minX = Math.min(...selectedUnlocked.map((layer) => layer.x));
      const minY = Math.min(...selectedUnlocked.map((layer) => layer.y));
      const maxX = Math.max(...selectedUnlocked.map((layer) => layer.x + layer.width));
      const maxY = Math.max(...selectedUnlocked.map((layer) => layer.y + layer.height));
      const dx = clamp(requestedX, -minX, previous.width - maxX);
      const dy = clamp(requestedY, -minY, previous.height - maxY);
      if (!dx && !dy) return previous;
      return {
        ...previous,
        layers: previous.layers.map((layer) => selectedIds.includes(layer.id) && !layer.locked
          ? { ...layer, x: layer.x + dx, y: layer.y + dy }
          : layer)
      };
    });
  }, [selectedIds, updateDraft]);
  const tryBack = useCallback(async () => {
    if (dirty && !confirm('尚未保存，确定离开编辑器吗？')) return;
    if (dirty) await onClearDraft(draftKey).catch(() => undefined);
    onBack();
  }, [dirty, draftKey, onBack, onClearDraft]);

  useEffect(() => {
    if (!initialStateRef.current.restored) return;
    notify('已恢复上次未保存的模板草稿');
  }, [notify]);

  useEffect(() => {
    if (!dirty) return undefined;
    const timer = setTimeout(() => {
      setAutosaveState('saving');
      onSaveDraft(draftKey, { kind: initial ? 'existing' : 'new', savedAt: Date.now(), draft })
        .then(() => setAutosaveState('saved'))
        .catch(() => { setAutosaveState('error'); notify('自动保存失败', 'error'); });
    }, 500);
    return () => clearTimeout(timer);
  }, [dirty, draft, draftKey, initial, notify, onSaveDraft]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault(); undoDraft();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && ((event.key.toLowerCase() === 'z' && event.shiftKey) || event.key.toLowerCase() === 'y')) {
        event.preventDefault(); redoDraft();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && !isTextEditingTarget(event.target)) {
        if (event.key.toLowerCase() === 'c' && selectedIds.length) {
          event.preventDefault(); copySelectedLayers();
          return;
        }
        if (event.key.toLowerCase() === 'v') {
          event.preventDefault(); pasteLayers();
          return;
        }
      }
      if (event.key === 'Delete' && !isTextEditingTarget(event.target) && selectedIds.length) {
        event.preventDefault();
        removeSelectedLayers();
        return;
      }
      if (event.key.startsWith('Arrow') && !event.ctrlKey && !event.metaKey && !event.altKey && !isTextEditingTarget(event.target) && selectedIds.length) {
        event.preventDefault();
        nudgeSelectedLayers(event.key, event.shiftKey ? 10 : 1);
        return;
      }
      if (event.key === 'Escape' && !event.repeat) {
        event.preventDefault();
        tryBack();
      }
    };
    const closeMenus = () => { setShapeMenu(false); setLayerMenu(null); };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', closeMenus);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('pointerdown', closeMenus); };
  }, [copySelectedLayers, nudgeSelectedLayers, pasteLayers, redoDraft, removeSelectedLayers, selectedIds.length, tryBack, undoDraft]);

  useEffect(() => {
    const available = new Set(draft.layers.map((layer) => layer.id));
    setSelectedIds((current) => current.filter((id) => available.has(id)));
  }, [draft.layers]);

  const addImage = async (file) => {
    try {
      const src = await fileToDataUrl(file); const image = await loadImage(src);
      const maxW = draft.width * .9; const maxH = draft.height * .9;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1);
      const width = Math.round(image.width * scale); const height = Math.round(image.height * scale);
      const layer = { id: uid(), name: file.name.replace(/\.[^.]+$/, ''), type: 'static', src, x: Math.round((draft.width - width) / 2), y: Math.round((draft.height - height) / 2), width, height, rotation: 0, visible: true, fit: 'fill' };
      updateDraft((prev) => ({ ...prev, layers: [...prev.layers, layer] })); setSelectedIds([layer.id]);
    } catch (error) { notify(error.message, 'error'); }
  };

  const addEmptySlot = (shape) => {
    const size = Math.round(Math.min(draft.width, draft.height) * .52);
    const width = shape === 'circle' ? size : Math.round(draft.width * .6);
    const height = shape === 'circle' ? size : Math.round(draft.height * .48);
    const shapeName = shape === 'circle' ? '圆形' : shape === 'rounded' ? '圆角矩形' : '矩形';
    const layer = { id: uid(), name: `${shapeName}照片 ${draft.layers.filter((x) => x.type === 'slot').length + 1}`, type: 'slot', shape, src: '', x: Math.round((draft.width - width) / 2), y: Math.round((draft.height - height) / 2), width, height, rotation: 0, visible: true, fit: 'cover' };
    updateDraft((prev) => ({ ...prev, layers: [...prev.layers, layer] })); setSelectedIds([layer.id]);
    setShapeMenu(false);
  };

  const addTextLayer = () => {
    const layer = { id: uid(), name: `文字 ${draft.layers.filter((item) => item.type === 'text').length + 1}`, type: 'text', text: '输入文字', x: Math.round(draft.width * .18), y: Math.round(draft.height * .18), width: Math.round(draft.width * .64), height: 130, rotation: 0, visible: true, fontSize: 48, fontFamily: 'Microsoft YaHei', fontStyle: 'normal', textDecoration: '', align: 'center', fill: '#22211f', lineHeight: 1.25, autoFit: false, stroke: '#ffffff', strokeWidth: 0, shadowEnabled: false, shadowColor: '#000000', shadowBlur: 8, shadowOffsetX: 2, shadowOffsetY: 2, background: '', backgroundPadding: 8 };
    updateDraft((prev) => ({ ...prev, layers: [...prev.layers, layer] })); setSelectedIds([layer.id]);
  };

  const openLayerMenu = (id, event) => {
    event.preventDefault(); event.stopPropagation(); selectLayer(id, event);
    setLayerMenu({ id, x: Math.min(event.clientX, window.innerWidth - 166), y: Math.min(event.clientY, window.innerHeight - 334) });
  };

  const removeLayer = (id) => {
    const layer = draft.layers.find((item) => item.id === id);
    if (layer?.locked) return notify('请先解锁图层', 'error');
    updateDraft((prev) => ({ ...prev, layers: prev.layers.filter((x) => x.id !== id) }));
    setSelectedIds((current) => current.filter((item) => item !== id));
  };
  const moveLayer = (id, direction) => updateDraft((prev) => {
    const index = prev.layers.findIndex((x) => x.id === id); const nextIndex = clamp(index + direction, 0, prev.layers.length - 1);
    if (prev.layers[index]?.locked) return prev;
    const layers = [...prev.layers]; const [item] = layers.splice(index, 1); layers.splice(nextIndex, 0, item); return { ...prev, layers };
  });
  const reorderLayer = (sourceId, targetId, placement) => {
    if (!sourceId || sourceId === targetId) return;
    updateDraft((previous) => {
      const layers = [...previous.layers];
      const sourceIndex = layers.findIndex((item) => item.id === sourceId);
      if (sourceIndex < 0 || layers[sourceIndex].locked) return previous;
      const [source] = layers.splice(sourceIndex, 1);
      const targetIndex = layers.findIndex((item) => item.id === targetId);
      if (targetIndex < 0) return previous;
      layers.splice(placement === 'before' ? targetIndex + 1 : targetIndex, 0, source);
      return { ...previous, layers };
    });
    setSelectedIds([sourceId]);
  };
  const beginLayerReorder = (event, sourceId) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectLayer(sourceId, event);
    const start = { x: event.clientX, y: event.clientY };
    const resolveTarget = (pointerEvent) => {
      const row = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest('.layer-row[data-layer-id]');
      const targetId = row?.dataset.layerId;
      if (!targetId || targetId === sourceId) return null;
      const rect = row.getBoundingClientRect();
      return { id: targetId, placement: pointerEvent.clientY < rect.top + rect.height / 2 ? 'before' : 'after' };
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      layerReorderRef.current = null;
    };
    const move = (pointerEvent) => {
      if (!layerReorderRef.current?.active && Math.hypot(pointerEvent.clientX - start.x, pointerEvent.clientY - start.y) < 4) return;
      if (layerReorderRef.current) layerReorderRef.current.active = true;
      setDraggedLayerId(sourceId);
      const target = resolveTarget(pointerEvent);
      setLayerDrop((current) => current?.id === target?.id && current?.placement === target?.placement ? current : target);
    };
    const finish = (pointerEvent) => {
      const active = layerReorderRef.current?.active;
      const target = resolveTarget(pointerEvent);
      cleanup();
      if (active && target) reorderLayer(sourceId, target.id, target.placement);
      setDraggedLayerId(null);
      setLayerDrop(null);
    };
    layerReorderRef.current?.cleanup?.();
    layerReorderRef.current = { active: false, cleanup };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  };
  const groupSelected = () => {
    if (selectedIds.length < 2) return;
    const groupId = uid();
    updateDraft((previous) => ({ ...previous, layers: previous.layers.map((layer) => selectedIds.includes(layer.id) ? { ...layer, groupId } : layer) }));
  };
  const ungroupSelected = () => {
    if (!selectedGroupId) return;
    updateDraft((previous) => ({ ...previous, layers: previous.layers.map((layer) => layer.groupId === selectedGroupId ? { ...layer, groupId: undefined } : layer) }));
  };
  const toggleSelectedLock = () => {
    if (!selectedIds.length) return;
    const lock = selectedLayers.some((layer) => !layer.locked);
    updateDraft((previous) => ({ ...previous, layers: previous.layers.map((layer) => selectedIds.includes(layer.id) ? { ...layer, locked: lock } : layer) }));
  };
  const alignSelected = (mode) => {
    const layers = selectedLayers.filter((layer) => !layer.locked);
    if (layers.length < 2) return;
    const left = Math.min(...layers.map((layer) => layer.x));
    const right = Math.max(...layers.map((layer) => layer.x + layer.width));
    const top = Math.min(...layers.map((layer) => layer.y));
    const bottom = Math.max(...layers.map((layer) => layer.y + layer.height));
    const patches = Object.fromEntries(layers.map((layer) => {
      const patch = mode === 'left' ? { x: left }
        : mode === 'center' ? { x: Math.round((left + right - layer.width) / 2) }
          : mode === 'right' ? { x: right - layer.width }
            : mode === 'top' ? { y: top }
              : mode === 'middle' ? { y: Math.round((top + bottom - layer.height) / 2) }
                : { y: bottom - layer.height };
      return [layer.id, patch];
    }));
    updateLayers(patches);
  };
  const distributeSelected = (axis) => {
    const layers = selectedLayers.filter((layer) => !layer.locked);
    if (layers.length < 3) return;
    const sorted = [...layers].sort((a, b) => axis === 'x' ? a.x + a.width / 2 - b.x - b.width / 2 : a.y + a.height / 2 - b.y - b.height / 2);
    const centerOf = (layer) => axis === 'x' ? layer.x + layer.width / 2 : layer.y + layer.height / 2;
    const start = centerOf(sorted[0]); const end = centerOf(sorted.at(-1)); const step = (end - start) / (sorted.length - 1);
    const patches = Object.fromEntries(sorted.map((layer, index) => [layer.id, axis === 'x' ? { x: Math.round(start + step * index - layer.width / 2) } : { y: Math.round(start + step * index - layer.height / 2) }]));
    updateLayers(patches);
  };
  const copyLayerFromMenu = (id) => {
    const layer = draft.layers.find((item) => item.id === id);
    if (!layer) return;
    const layers = layer.groupId ? draft.layers.filter((item) => item.groupId === layer.groupId) : [layer];
    clipboardLayersRef.current = structuredClone(layers);
    notify(layers.length > 1 ? `已复制 ${layers.length} 个组合图层` : `已复制图层“${layer.name}”`);
  };
  const duplicateLayerFromMenu = (id) => {
    const layer = draft.layers.find((item) => item.id === id);
    if (!layer) return;
    const sourceLayers = layer.groupId ? draft.layers.filter((item) => item.groupId === layer.groupId) : [layer];
    const nextGroupId = sourceLayers.length > 1 ? uid() : undefined;
    const copies = sourceLayers.map((source) => ({
      ...structuredClone(source),
      id: uid(),
      groupId: nextGroupId,
      name: `${source.name} 副本`,
      x: clamp(source.x + 20, 0, Math.max(0, draft.width - source.width)),
      y: clamp(source.y + 20, 0, Math.max(0, draft.height - source.height)),
      locked: false
    }));
    updateDraft((previous) => ({ ...previous, layers: [...previous.layers, ...copies] }));
    setSelectedIds(copies.map((copy) => copy.id));
  };
  const moveLayerExtreme = (id, toFront) => updateDraft((previous) => {
    const index = previous.layers.findIndex((layer) => layer.id === id);
    if (index < 0 || previous.layers[index].locked) return previous;
    const layers = [...previous.layers];
    const [layer] = layers.splice(index, 1);
    if (toFront) layers.push(layer); else layers.unshift(layer);
    return { ...previous, layers };
  });
  useEffect(() => () => layerReorderRef.current?.cleanup?.(), []);
  const save = async () => {
    if (!draft.name.trim()) return notify('请填写模板名称', 'error');
    if (!draft.layers.length) return notify('请至少添加一个图层', 'error');
    if (!draft.layers.some((layer) => layer.type === 'slot')) return notify('请至少添加一个照片位置', 'error');
    const finalDraft = { ...draft, name: draft.name.trim(), updatedAt: Date.now() };
    await onSave(finalDraft);
    await onClearDraft(draftKey).catch(() => undefined);
  };

  return <main className="editor-page">
    <header className="editor-topbar"><div className="editor-left"><IconButton label="返回模板库" onClick={tryBack}><ArrowLeft size={21}/></IconButton><div className="title-field"><input value={draft.name} onChange={(e) => updateDraft({ ...draft, name: e.target.value })}/><span>{draft.width} x {draft.height}px</span></div></div><div className="editor-center"><span className="status-dot"></span>{autosaveState === 'saving' ? '正在自动保存' : autosaveState === 'error' ? '自动保存失败' : initialStateRef.current.restored ? '已恢复草稿' : dirty ? '已自动保存' : '已保存'}</div><div className="editor-actions"><IconButton label="撤销 (Ctrl+Z)" onClick={undoDraft} disabled={!canUndo}><Undo2 size={18}/></IconButton><IconButton label="重做 (Ctrl+Shift+Z)" onClick={redoDraft} disabled={!canRedo}><Redo2 size={18}/></IconButton><button className="secondary-button" onClick={tryBack}>取消</button><button className="primary-button" onClick={save}><Save size={17}/>保存模板</button></div></header>
    <div className="editor-body">
      <aside className="layers-panel"><div className="panel-title"><div><span>图层</span><small>{draft.layers.length}</small></div><IconButton label="添加可替换照片" onClick={(event) => { event.stopPropagation(); setShapeMenu(!shapeMenu); }}><Plus size={18}/></IconButton></div><div className="layer-add-row"><button onClick={() => memeInput.current.click()}><ImagePlus size={18}/><span>添加固定图层</span></button><div className="shape-picker-wrap"><button onClick={(event) => { event.stopPropagation(); setShapeMenu(!shapeMenu); }}><Shapes size={18}/><span>添加可替换照片</span></button>{shapeMenu && <div className="shape-picker" onPointerDown={(event) => event.stopPropagation()}><button onClick={() => addEmptySlot('rect')}><Square size={17}/><span>矩形</span></button><button onClick={() => addEmptySlot('circle')}><Circle size={17}/><span>圆形</span></button><button onClick={() => addEmptySlot('rounded')}><Shapes size={17}/><span>圆角矩形</span></button></div>}</div><button onClick={addTextLayer}><Type size={18}/><span>添加文字</span></button></div><label className="template-tags-field"><span>模板标签</span><input value={tagsText} onChange={(event) => { const value = event.target.value; setTagsText(value); updateDraft({ ...draft, tags: value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 10) }); }} placeholder="反应、工作、猫"/></label><input ref={memeInput} hidden type="file" accept="image/*" onChange={(event) => event.target.files[0] && addImage(event.target.files[0])}/>
        <div className="layers-list">{[...draft.layers].reverse().map((layer) => {
          const dropClass = layerDrop?.id === layer.id ? `drop-${layerDrop.placement}` : '';
          return <div
            key={layer.id}
            data-layer-id={layer.id}
            className={`layer-row ${selectedIds.includes(layer.id) ? 'selected' : ''} ${draggedLayerId === layer.id ? 'dragging' : ''} ${dropClass} ${layer.locked ? 'locked' : ''}`}
            onClick={(event) => selectLayer(layer.id, event)}
            onContextMenu={(event) => openLayerMenu(layer.id, event)}
          ><span className="layer-grip" title={layer.locked ? '图层已锁定' : '拖动排序'} onPointerDown={(event) => { if (!layer.locked) beginLayerReorder(event, layer.id); }}><GripVertical size={15}/></span><div className={`layer-thumb ${layer.type}`}><LayerThumb layer={layer}/></div><div className="layer-copy"><strong>{layer.name}</strong><span>{layer.type === 'slot' ? `${shapeOf(layer) === 'circle' ? '圆形' : shapeOf(layer) === 'rounded' ? '圆角矩形' : '矩形'}照片` : layer.type === 'text' ? '文字图层' : '固定图层'}{layer.groupId ? ' · 已组合' : ''}</span></div><IconButton label={layer.locked ? '解锁图层' : '锁定图层'} onClick={(event) => { event.stopPropagation(); updateLayer(layer.id, { locked: !layer.locked }); }}>{layer.locked ? <Lock size={15}/> : <Unlock size={15}/>}</IconButton><IconButton label={layer.visible ? '隐藏图层' : '显示图层'} onClick={(event) => { event.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }}>{layer.visible ? <Eye size={16}/> : <EyeOff size={16}/>}</IconButton></div>;
        })}</div>
        {!draft.layers.length && <div className="layers-empty"><Layers3 size={28}/><p>先添加 Meme 底图，再添加一个照片位置。</p></div>}
      </aside>
      <section className="canvas-workspace"><div className="canvas-toolbar"><div className="canvas-size"><label>画布</label><input type="number" min="100" max="4000" value={draft.width} onChange={(e) => updateDraft({ ...draft, width: clamp(e.target.value, 100, 4000) })}/><span>×</span><input type="number" min="100" max="4000" value={draft.height} onChange={(e) => updateDraft({ ...draft, height: clamp(e.target.value, 100, 4000) })}/></div><div className="selection-actions">{selectedIds.length > 1 && <button className="toolbar-button" onClick={groupSelected}><Layers3 size={15}/>组合</button>}{selectedGroupId && <button className="toolbar-button" onClick={ungroupSelected}><Layers3 size={15}/>取消组合</button>}{selectedIds.length > 0 && <button className="toolbar-button" onClick={toggleSelectedLock}>{selectedLayers.some((layer) => !layer.locked) ? <Lock size={15}/> : <Unlock size={15}/>} {selectedLayers.some((layer) => !layer.locked) ? '锁定' : '解锁'}</button>}</div><div className="zoom-control"><IconButton label="缩小" onClick={() => setZoom((current) => current - .1)}><ZoomOut size={17}/></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton label="放大" onClick={() => setZoom((current) => current + .1)}><ZoomIn size={17}/></IconButton></div></div><div className={`canvas-scroll pan-viewport ${panning ? 'panning' : ''}`} onWheel={zoomAtPointer} onMouseDown={(event) => { if (event.target === event.currentTarget) beginPan(event); }}><div className="stage-shadow" style={{ width: draft.width * zoom, height: draft.height * zoom, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)` }}><EditorStage template={draft} selectedIds={selectedIds} selectedId={selectedId} setSelectedIds={setSelectedIds} selectLayer={selectLayer} updateLayer={updateLayer} updateLayers={updateLayers} onLayerContextMenu={openLayerMenu} onPanStart={beginPan} zoom={zoom}/></div></div></section>
      <aside className="properties-panel"><div className="panel-title"><span>属性</span></div>{selectedLayers.length > 1 ? <MultiSelectionProperties layers={selectedLayers} grouped={Boolean(selectedGroupId)} onGroup={groupSelected} onUngroup={ungroupSelected} onToggleLock={toggleSelectedLock} onAlign={alignSelected} onDistribute={distributeSelected}/> : selected ? <Properties layer={selected} update={(patch) => updateLayer(selected.id, patch)} toggleLock={() => updateLayer(selected.id, { locked: !selected.locked })} remove={() => removeLayer(selected.id)} move={(direction) => moveLayer(selected.id, direction)}/> : <div className="property-empty"><Pencil size={26}/><p>选择一个图层后，可调整位置、尺寸和旋转。</p></div>}</aside>
    </div>
    {layerMenu && <div className="layer-context-menu" style={{ left: layerMenu.x, top: Math.max(6, layerMenu.y) }} onPointerDown={(event) => event.stopPropagation()}>
      <button onClick={() => { copyLayerFromMenu(layerMenu.id); setLayerMenu(null); }}><Copy size={16}/>复制图层</button>
      <button onClick={() => { duplicateLayerFromMenu(layerMenu.id); setLayerMenu(null); }}><Plus size={16}/>创建副本</button>
      <button onClick={() => { const layer = draft.layers.find((item) => item.id === layerMenu.id); updateLayer(layerMenu.id, { locked: !layer?.locked }); setLayerMenu(null); }}>{draft.layers.find((item) => item.id === layerMenu.id)?.locked ? <Unlock size={16}/> : <Lock size={16}/>} {draft.layers.find((item) => item.id === layerMenu.id)?.locked ? '解锁图层' : '锁定图层'}</button>
      <button disabled={draft.layers.find((item) => item.id === layerMenu.id)?.locked} onClick={() => { moveLayer(layerMenu.id, 1); setLayerMenu(null); }}><ChevronUp size={16}/>上移图层</button>
      <button disabled={draft.layers.find((item) => item.id === layerMenu.id)?.locked} onClick={() => { moveLayer(layerMenu.id, -1); setLayerMenu(null); }}><ChevronDown size={16}/>下移图层</button>
      <button disabled={draft.layers.find((item) => item.id === layerMenu.id)?.locked} onClick={() => { moveLayerExtreme(layerMenu.id, true); setLayerMenu(null); }}><ChevronUp size={16}/>置于顶层</button>
      <button disabled={draft.layers.find((item) => item.id === layerMenu.id)?.locked} onClick={() => { moveLayerExtreme(layerMenu.id, false); setLayerMenu(null); }}><ChevronDown size={16}/>置于底层</button>
      <button className="danger" disabled={draft.layers.find((item) => item.id === layerMenu.id)?.locked} onClick={() => { removeLayer(layerMenu.id); setLayerMenu(null); }}><Trash2 size={16}/>删除图层</button>
    </div>}
  </main>;
}

function LayerThumb({ layer }) {
  const image = useHtmlImage(layer.src);
  if (layer.type === 'text') return <Type size={18}/>;
  if (image) return <img src={layer.src} alt=""/>;
  return <span className={`shape-thumb ${shapeOf(layer)}`}></span>;
}

function EditorStage({ template, selectedIds, setSelectedIds, selectLayer, updateLayer, updateLayers, onLayerContextMenu, onPanStart, zoom }) {
  const trRef = useRef();
  const nodeRefs = useRef({});
  const dragRef = useRef(null);
  const [guides, setGuides] = useState([]);

  useEffect(() => {
    const nodes = selectedIds
      .map((id) => template.layers.find((layer) => layer.id === id))
      .filter((layer) => layer && !layer.locked && layer.visible)
      .map((layer) => nodeRefs.current[layer.id])
      .filter(Boolean);
    if (trRef.current) {
      trRef.current.nodes(nodes);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [selectedIds, template.layers]);

  const startDrag = (layer) => {
    const groupedIds = layer.groupId ? template.layers.filter((item) => item.groupId === layer.groupId).map((item) => item.id) : [layer.id];
    const requestedIds = selectedIds.includes(layer.id) ? selectedIds : groupedIds;
    const ids = requestedIds.filter((id) => {
      const item = template.layers.find((candidate) => candidate.id === id);
      return item && !item.locked && item.visible;
    });
    if (!selectedIds.includes(layer.id)) setSelectedIds(groupedIds);
    const positions = Object.fromEntries(ids.map((id) => {
      const item = template.layers.find((candidate) => candidate.id === id);
      return [id, { x: item.x, y: item.y }];
    }));
    const items = template.layers.filter((item) => ids.includes(item.id));
    const minX = Math.min(...items.map((item) => item.x));
    const minY = Math.min(...items.map((item) => item.y));
    const maxX = Math.max(...items.map((item) => item.x + item.width));
    const maxY = Math.max(...items.map((item) => item.y + item.height));
    dragRef.current = { ids, positions, anchorId: layer.id, anchor: positions[layer.id], bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
  };

  const moveDrag = (layer, event) => {
    const drag = dragRef.current;
    if (!drag?.anchor || !drag.ids.includes(layer.id)) return;
    let dx = event.target.x() - drag.anchor.x;
    let dy = event.target.y() - drag.anchor.y;
    if (event.evt.shiftKey) {
      const virtualLayer = { id: '__selection__', width: drag.bounds.width, height: drag.bounds.height };
      const snapped = snapLayerPosition(virtualLayer, { x: drag.bounds.x + dx, y: drag.bounds.y + dy }, template, 8 / zoom, drag.ids);
      dx = snapped.x - drag.bounds.x;
      dy = snapped.y - drag.bounds.y;
      setGuides(snapped.guides);
    } else {
      setGuides((current) => current.length ? [] : current);
    }
    drag.ids.forEach((id) => nodeRefs.current[id]?.position({ x: drag.positions[id].x + dx, y: drag.positions[id].y + dy }));
  };

  const finishDrag = (layer, event) => {
    moveDrag(layer, event);
    const drag = dragRef.current;
    if (!drag) return;
    const patches = Object.fromEntries(drag.ids.map((id) => [id, { x: Math.round(nodeRefs.current[id].x()), y: Math.round(nodeRefs.current[id].y()) }]));
    dragRef.current = null;
    setGuides([]);
    updateLayers(patches);
  };

  const finishTransform = () => {
    const patches = {};
    selectedIds.forEach((id) => {
      const layer = template.layers.find((item) => item.id === id);
      const node = nodeRefs.current[id];
      if (!node || layer?.locked) return;
      const sx = node.scaleX(); const sy = node.scaleY();
      patches[id] = { x: Math.round(node.x()), y: Math.round(node.y()), width: Math.max(10, Math.round(node.width() * sx)), height: Math.max(10, Math.round(node.height() * sy)), rotation: Math.round(node.rotation()) };
      node.scaleX(1); node.scaleY(1);
    });
    if (Object.keys(patches).length) updateLayers(patches);
  };

  return <Stage width={template.width * zoom} height={template.height * zoom} scaleX={zoom} scaleY={zoom} onWheel={(event) => event.target.stopDrag?.()} onMouseDown={(event) => { if (event.target === event.target.getStage() || event.target.name() === 'editor-background') { setSelectedIds([]); onPanStart(event); } }}><Layer><Rect name="editor-background" width={template.width} height={template.height} fill="#fff"/>{template.layers.map((layer) => <EditorLayer key={layer.id} layer={layer} interactive={!layer.locked} selectable setRef={(node) => nodeRefs.current[layer.id] = node} onSelect={(event) => selectLayer(layer.id, event.evt)} onContextMenu={(event) => onLayerContextMenu(layer.id, event.evt)} onChange={(patch) => updateLayer(layer.id, patch)} onDragStart={() => startDrag(layer)} onDragMove={(event) => moveDrag(layer, event)} onDragEnd={(event) => finishDrag(layer, event)} onTransformEnd={false}/>)}{template.layers.filter((layer) => layer.locked && selectedIds.includes(layer.id) && layer.visible).map((layer) => <Rect key={`locked-${layer.id}`} x={layer.x} y={layer.y} width={layer.width} height={layer.height} rotation={layer.rotation || 0} stroke="#e24b35" strokeWidth={2 / zoom} dash={[7 / zoom, 5 / zoom]} listening={false}/>)}{guides.map((guide, index) => <Line key={`${guide.axis}-${guide.value}-${index}`} points={guide.axis === 'x' ? [guide.value, 0, guide.value, template.height] : [0, guide.value, template.width, guide.value]} stroke="#e94e37" strokeWidth={1.5 / zoom} dash={[6 / zoom, 4 / zoom]} listening={false}/>) }<Transformer ref={trRef} onTransformEnd={finishTransform} rotateEnabled enabledAnchors={['top-left','top-right','bottom-left','bottom-right','middle-left','middle-right','top-center','bottom-center']} borderStroke="#e24b35" anchorFill="#fff" anchorStroke="#e24b35" anchorSize={10 / zoom} borderStrokeWidth={2 / zoom} boundBoxFunc={(oldBox, newBox) => (newBox.width < 24 || newBox.height < 24) ? oldBox : newBox}/></Layer></Stage>;
}

function EditorLayer({ layer, setRef, onSelect, onContextMenu, onChange, onDragStart, onDragMove, onDragEnd, onTransformEnd, interactive = true, selectable = interactive, source, highlight = false, cropMode = false, photoTransform, onEnterCrop, onPhotoTransform, onPhotoTransformMove, onPhotoTransformEnd }) {
  const image = useHtmlImage(source ?? layer.src);
  const crop = image && layer.fit === 'cover' ? getCoverCrop(image, layer.width, layer.height) : undefined;
  const placement = image && layer.type === 'slot' && source ? getPhotoPlacement(image, layer, photoTransform) : null;
  if (!layer.visible) return null;
  const common = { ref: setRef, x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotation: layer.rotation || 0, draggable: interactive, listening: selectable };
  if (selectable) Object.assign(common, { onClick: onSelect, onTap: onSelect, onDblClick: onEnterCrop, onDblTap: onEnterCrop, onContextMenu });
  if (interactive) {
    Object.assign(common, { onDragStart, onDragMove, onDragEnd: onDragEnd || ((event) => onChange({ x: Math.round(event.target.x()), y: Math.round(event.target.y()) })) });
    if (onTransformEnd !== false) common.onTransformEnd = onTransformEnd || ((event) => { const node = event.target; const sx = node.scaleX(), sy = node.scaleY(); node.scaleX(1); node.scaleY(1); onChange({ x: Math.round(node.x()), y: Math.round(node.y()), width: Math.max(10, Math.round(node.width() * sx)), height: Math.max(10, Math.round(node.height() * sy)), rotation: Math.round(node.rotation()) }); });
  }
  if (layer.type === 'text') {
    const padding = Math.max(0, Number(layer.backgroundPadding) || 0);
    return <Group {...common}>
      {layer.background && <Rect width={layer.width} height={layer.height} fill={layer.background}/>}
      <KonvaText x={padding} y={padding} width={Math.max(1, layer.width - padding * 2)} height={Math.max(1, layer.height - padding * 2)} text={layer.text || ''} fontSize={resolveTextFontSize(layer)} fontFamily={layer.fontFamily || 'Microsoft YaHei'} fontStyle={layer.fontStyle || 'normal'} textDecoration={layer.textDecoration || ''} align={layer.align || 'left'} fill={layer.fill || '#22211f'} stroke={(layer.strokeWidth || 0) > 0 ? layer.stroke || '#ffffff' : undefined} strokeWidth={Number(layer.strokeWidth) || 0} lineJoin="round" shadowEnabled={Boolean(layer.shadowEnabled)} shadowColor={layer.shadowColor || '#000000'} shadowBlur={Number(layer.shadowBlur) || 0} shadowOffsetX={Number(layer.shadowOffsetX) || 0} shadowOffsetY={Number(layer.shadowOffsetY) || 0} lineHeight={layer.lineHeight || 1.25} wrap="char" verticalAlign="top"/>
    </Group>;
  }
  const clipFunc = (ctx) => traceLayerShape(ctx, layer);
  const placeholderProps = { fill: highlight ? 'rgba(233,78,55,.14)' : '#eceae4', stroke: highlight ? '#e94e37' : '#77746d', strokeWidth: highlight ? 5 : 2, dash: [12, 8] };
  return <Group {...common} clipFunc={layer.type === 'slot' ? clipFunc : undefined}>
    {image ? <KonvaImage image={image} x={placement?.x || 0} y={placement?.y || 0} width={placement?.width || layer.width} height={placement?.height || layer.height} crop={placement ? undefined : crop} draggable={cropMode} onDragMove={cropMode && placement ? (event) => { const x = clamp(event.target.x(), layer.width - placement.width, 0); const y = clamp(event.target.y(), layer.height - placement.height, 0); onPhotoTransformMove ? onPhotoTransformMove({ event, x, y, placement }) : event.target.position({ x, y }); } : undefined} onDragEnd={cropMode && placement ? (event) => { const x = clamp(event.target.x(), layer.width - placement.width, 0); const y = clamp(event.target.y(), layer.height - placement.height, 0); event.target.position({ x, y }); if (onPhotoTransformEnd) onPhotoTransformEnd({ event, x, y, placement }); else onPhotoTransform?.({ offsetX: x - placement.centeredX, offsetY: y - placement.centeredY }); } : undefined}/> : shapeOf(layer) === 'circle' ? <Ellipse x={layer.width / 2} y={layer.height / 2} radiusX={layer.width / 2} radiusY={layer.height / 2} {...placeholderProps}/> : <Rect width={layer.width} height={layer.height} cornerRadius={shapeOf(layer) === 'rounded' ? Math.min(36, layer.width / 4, layer.height / 4) : 0} {...placeholderProps}/>}
    {cropMode && <Rect x={1} y={1} width={Math.max(0, layer.width - 2)} height={Math.max(0, layer.height - 2)} stroke="#e94e37" strokeWidth={3} dash={[10, 7]} listening={false}/>}
  </Group>;
}

function NumberField({ label, value, onChange, suffix }) { return <label className="number-field"><span>{label}</span><div><input type="number" value={Math.round(value)} onChange={(e) => onChange(Number(e.target.value))}/>{suffix && <em>{suffix}</em>}</div></label>; }

function MultiSelectionProperties({ layers, grouped, onGroup, onUngroup, onToggleLock, onAlign, onDistribute }) {
  const allLocked = layers.every((layer) => layer.locked);
  const unlockedCount = layers.filter((layer) => !layer.locked).length;
  return <div className="property-content multi-selection-properties">
    <div className="multi-selection-summary"><Layers3 size={24}/><strong>已选择 {layers.length} 个图层</strong><span>拖动画布中的任一选中图层可整体移动。</span></div>
    <div className="property-section"><h4>对齐</h4><div className="multi-align-grid">
      <IconButton label="左对齐" disabled={unlockedCount < 2} onClick={() => onAlign('left')}><AlignHorizontalJustifyStart size={16}/></IconButton>
      <IconButton label="水平居中" disabled={unlockedCount < 2} onClick={() => onAlign('center')}><AlignHorizontalJustifyCenter size={16}/></IconButton>
      <IconButton label="右对齐" disabled={unlockedCount < 2} onClick={() => onAlign('right')}><AlignHorizontalJustifyEnd size={16}/></IconButton>
      <IconButton label="顶部对齐" disabled={unlockedCount < 2} onClick={() => onAlign('top')}><AlignVerticalJustifyStart size={16}/></IconButton>
      <IconButton label="垂直居中" disabled={unlockedCount < 2} onClick={() => onAlign('middle')}><AlignVerticalJustifyCenter size={16}/></IconButton>
      <IconButton label="底部对齐" disabled={unlockedCount < 2} onClick={() => onAlign('bottom')}><AlignVerticalJustifyEnd size={16}/></IconButton>
    </div></div>
    <div className="property-section"><h4>等距分布</h4><div className="distribution-buttons"><button disabled={unlockedCount < 3} onClick={() => onDistribute('x')}><AlignHorizontalDistributeCenter size={16}/>水平等距</button><button disabled={unlockedCount < 3} onClick={() => onDistribute('y')}><AlignVerticalDistributeCenter size={16}/>垂直等距</button></div></div>
    <div className="property-section"><h4>组合</h4><button className="wide-property-button" onClick={grouped ? onUngroup : onGroup}><Layers3 size={16}/>{grouped ? '取消组合' : '组合图层'}</button></div>
    <div className="property-section"><h4>锁定</h4><button className="wide-property-button" onClick={onToggleLock}>{allLocked ? <Unlock size={16}/> : <Lock size={16}/>} {allLocked ? '解锁所选图层' : '锁定所选图层'}</button></div>
  </div>;
}

function Properties({ layer, update, toggleLock, remove, move }) {
  const fontTokens = String(layer.fontStyle || '').split(' ').filter((token) => token && token !== 'normal');
  const decorationTokens = String(layer.textDecoration || '').split(' ').filter(Boolean);
  const toggleFont = (token) => update({ fontStyle: fontTokens.includes(token) ? fontTokens.filter((item) => item !== token).join(' ') || 'normal' : [...fontTokens, token].join(' ') });
  const toggleDecoration = (token) => update({ textDecoration: decorationTokens.includes(token) ? decorationTokens.filter((item) => item !== token).join(' ') : [...decorationTokens, token].join(' ') });

  return <div className="property-content">
    <button className={`layer-lock-button ${layer.locked ? 'active' : ''}`} onClick={toggleLock}>{layer.locked ? <Lock size={16}/> : <Unlock size={16}/>}<span>{layer.locked ? '图层已锁定' : '锁定图层'}</span></button>
    <label className="text-field"><span>图层名称</span><input value={layer.name} onChange={(event) => update({ name: event.target.value })}/></label>
    {layer.type === 'text' && <>
      <div className="property-section text-content-section"><h4>文字内容</h4><textarea value={layer.text || ''} onChange={(event) => update({ text: event.target.value })}/></div>
      <div className="property-section"><h4>字体</h4><select className="property-select" value={layer.fontFamily || 'Microsoft YaHei'} onChange={(event) => update({ fontFamily: event.target.value })}><option value="Microsoft YaHei">微软雅黑</option><option value="SimHei">黑体</option><option value="SimSun">宋体</option><option value="KaiTi">楷体</option><option value="Arial">Arial</option><option value="Segoe UI">Segoe UI</option></select><div className="text-format-row"><label><span>字号</span><input type="number" min="8" max="400" value={layer.fontSize || 48} onChange={(event) => update({ fontSize: clamp(event.target.value, 8, 400) })}/></label><input className="color-swatch" type="color" title="文字颜色" value={layer.fill || '#22211f'} onChange={(event) => update({ fill: event.target.value })}/></div><label className="check-row"><input type="checkbox" checked={Boolean(layer.autoFit)} onChange={(event) => update({ autoFit: event.target.checked })}/><span>文字自动适配文本框</span></label><div className="format-buttons"><button title="加粗" className={fontTokens.includes('bold') ? 'active' : ''} onClick={() => toggleFont('bold')}><Bold size={17}/></button><button title="斜体" className={fontTokens.includes('italic') ? 'active' : ''} onClick={() => toggleFont('italic')}><Italic size={17}/></button><button title="下划线" className={decorationTokens.includes('underline') ? 'active' : ''} onClick={() => toggleDecoration('underline')}><Underline size={17}/></button><button title="删除线" className={decorationTokens.includes('line-through') ? 'active' : ''} onClick={() => toggleDecoration('line-through')}><Strikethrough size={17}/></button></div><div className="format-buttons align-buttons"><button title="左对齐" className={layer.align === 'left' ? 'active' : ''} onClick={() => update({ align: 'left' })}><AlignLeft size={17}/></button><button title="居中" className={layer.align === 'center' ? 'active' : ''} onClick={() => update({ align: 'center' })}><AlignCenter size={17}/></button><button title="右对齐" className={layer.align === 'right' ? 'active' : ''} onClick={() => update({ align: 'right' })}><AlignRight size={17}/></button></div></div>
      <div className="property-section"><h4>文字效果</h4><div className="effect-grid"><label><span>描边</span><input type="color" value={layer.stroke || '#ffffff'} onChange={(event) => update({ stroke: event.target.value })}/></label><NumberField label="描边宽度" value={layer.strokeWidth || 0} onChange={(strokeWidth) => update({ strokeWidth: clamp(strokeWidth, 0, 30) })}/><label><span>背景</span><input type="color" value={layer.background || '#ffffff'} onChange={(event) => update({ background: event.target.value })}/></label><NumberField label="背景内边距" value={layer.backgroundPadding || 0} onChange={(backgroundPadding) => update({ backgroundPadding: clamp(backgroundPadding, 0, 100) })}/></div><button className="wide-property-button subtle" onClick={() => update({ background: layer.background ? '' : '#ffffff' })}>{layer.background ? '移除文字背景' : '启用文字背景'}</button><label className="check-row"><input type="checkbox" checked={Boolean(layer.shadowEnabled)} onChange={(event) => update({ shadowEnabled: event.target.checked })}/><span>启用文字阴影</span></label>{layer.shadowEnabled && <div className="effect-grid"><label><span>阴影颜色</span><input type="color" value={layer.shadowColor || '#000000'} onChange={(event) => update({ shadowColor: event.target.value })}/></label><NumberField label="模糊" value={layer.shadowBlur || 0} onChange={(shadowBlur) => update({ shadowBlur: clamp(shadowBlur, 0, 50) })}/><NumberField label="水平偏移" value={layer.shadowOffsetX || 0} onChange={(shadowOffsetX) => update({ shadowOffsetX })}/><NumberField label="垂直偏移" value={layer.shadowOffsetY || 0} onChange={(shadowOffsetY) => update({ shadowOffsetY })}/></div>}</div>
    </>}
    <div className="property-section"><h4>位置</h4><div className="property-grid"><NumberField label="X" value={layer.x} onChange={(x) => update({ x })}/><NumberField label="Y" value={layer.y} onChange={(y) => update({ y })}/></div></div>
    <div className="property-section"><h4>尺寸</h4><div className="property-grid"><NumberField label="宽" value={layer.width} onChange={(width) => update({ width: Math.max(10, width) })}/><NumberField label="高" value={layer.height} onChange={(height) => update({ height: Math.max(10, height) })}/></div></div>
    <div className="property-section"><h4>旋转</h4><NumberField label="角度" value={layer.rotation} onChange={(rotation) => update({ rotation })} suffix="°"/><input className="range" type="range" min="-180" max="180" value={layer.rotation} onChange={(event) => update({ rotation: Number(event.target.value) })}/></div>
    {layer.type === 'slot' && <><div className="property-section"><h4>槽位形状</h4><div className="shape-segmented"><button className={shapeOf(layer) === 'rect' ? 'active' : ''} onClick={() => update({ shape: 'rect' })}>矩形</button><button className={shapeOf(layer) === 'circle' ? 'active' : ''} onClick={() => update({ shape: 'circle' })}>圆形</button><button className={shapeOf(layer) === 'rounded' ? 'active' : ''} onClick={() => update({ shape: 'rounded' })}>圆角</button></div></div><div className="property-section"><h4>照片填充</h4><div className="segmented"><button className={layer.fit === 'cover' ? 'active' : ''} onClick={() => update({ fit: 'cover' })}>裁切铺满</button><button className={layer.fit === 'fill' ? 'active' : ''} onClick={() => update({ fit: 'fill' })}>拉伸填满</button></div></div></>}
    <div className="property-section"><h4>图层顺序</h4><div className="order-buttons"><button disabled={layer.locked} onClick={() => move(1)}><ChevronUp size={17}/>上移</button><button disabled={layer.locked} onClick={() => move(-1)}><ChevronDown size={17}/>下移</button></div></div>
    <button className="delete-button" disabled={layer.locked} onClick={remove}><Trash2 size={17}/>删除图层</button>
  </div>;
}

function pointInLayer(x, y, layer) {
  const radians = -(layer.rotation || 0) * Math.PI / 180;
  const dx = x - layer.x; const dy = y - layer.y;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  if (localX < 0 || localY < 0 || localX > layer.width || localY > layer.height) return false;
  if (shapeOf(layer) !== 'circle') return true;
  const nx = (localX - layer.width / 2) / (layer.width / 2);
  const ny = (localY - layer.height / 2) / (layer.height / 2);
  return nx * nx + ny * ny <= 1;
}

function UseStage({ composition, slotSources, slotTransforms, selectedId, setSelectedId, updateLayer, cropModeId, setCropModeId, updatePhotoTransform, onRequestSlot, zoom, pan, panning, onPanStart, transparent, lockAspectRatio }) {
  const hostRef = useRef();
  const transformerRef = useRef();
  const nodeRefs = useRef({});
  const dragRef = useRef(null);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [guides, setGuides] = useState([]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const updateSize = () => setHostSize({ width: host.clientWidth, height: host.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const fitScale = hostSize.width && hostSize.height
    ? Math.max(.05, Math.min((hostSize.width - 48) / composition.width, (hostSize.height - 48) / composition.height))
    : .1;
  const scale = fitScale * zoom;

  useEffect(() => {
    const node = !cropModeId && slotSources[selectedId] ? nodeRefs.current[selectedId] : null;
    if (transformerRef.current) {
      transformerRef.current.nodes(node ? [node] : []);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [composition.layers, cropModeId, scale, selectedId, slotSources]);

  const startSlotDrag = (layer) => {
    dragRef.current = { id: layer.id, x: layer.x, y: layer.y };
  };
  const moveSlotDrag = (layer, event) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== layer.id) return;
    let position = { x: event.target.x(), y: event.target.y() };
    if (event.evt.shiftKey) {
      const snapped = snapLayerPosition(layer, position, composition, 10 / scale, [layer.id]);
      position = { x: snapped.x, y: snapped.y };
      setGuides(snapped.guides);
    } else if (guides.length) setGuides([]);
    event.target.position(position);
  };
  const finishSlotDrag = (layer, event) => {
    moveSlotDrag(layer, event);
    const drag = dragRef.current;
    if (!drag || drag.id !== layer.id) return;
    updateLayer(layer.id, { x: Math.round(event.target.x()), y: Math.round(event.target.y()) });
    dragRef.current = null;
    setGuides([]);
  };
  const moveCropPhoto = (layer, payload) => {
    const { event, x, y, placement } = payload;
    let position = { x, y };
    if (event.evt.shiftKey) {
      const snapped = snapCropPosition(layer, placement, position, 8 / scale);
      position = { x: snapped.x, y: snapped.y };
      setGuides(snapped.guides.map((guide) => ({ ...guide, value: guide.axis === 'x' ? guide.value + layer.x : guide.value + layer.y })));
    } else if (guides.length) setGuides([]);
    event.target.position(position);
  };
  const finishCropPhoto = (layer, payload) => {
    moveCropPhoto(layer, payload);
    const x = payload.event.target.x();
    const y = payload.event.target.y();
    updatePhotoTransform(layer.id, { offsetX: x - payload.placement.centeredX, offsetY: y - payload.placement.centeredY });
    setGuides([]);
  };

  return <div className={`result-canvas-host pan-viewport ${panning ? 'panning' : ''}`} ref={hostRef} onMouseDown={(event) => { if (event.target === event.currentTarget) onPanStart(event); }}>
    {hostSize.width > 0 && <div className={`result-canvas-frame ${transparent ? 'transparent' : ''}`} style={{ width: composition.width * scale, height: composition.height * scale, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)` }}>
      <Stage width={composition.width * scale} height={composition.height * scale} scaleX={scale} scaleY={scale} onWheel={(event) => event.target.stopDrag?.()} onMouseDown={(event) => { if (event.target === event.target.getStage() || event.target.name() === 'result-background') { setSelectedId(null); setCropModeId(null); onPanStart(event); } }}>
        <Layer>
          <Rect name="result-background" width={composition.width} height={composition.height} fill={transparent ? 'rgba(0,0,0,0)' : '#fff'}/>
          {composition.layers.map((layer) => <EditorLayer
            key={layer.id}
            layer={layer}
            source={layer.type === 'slot' ? slotSources[layer.id] : undefined}
            photoTransform={slotTransforms[layer.id]}
            cropMode={cropModeId === layer.id}
            interactive={layer.type === 'slot' && Boolean(slotSources[layer.id]) && cropModeId !== layer.id}
            selectable={layer.type === 'slot'}
            highlight={layer.type === 'slot' && !slotSources[layer.id]}
            setRef={(node) => { if (layer.type === 'slot') nodeRefs.current[layer.id] = node; }}
            onSelect={() => { setSelectedId(layer.id); if (!slotSources[layer.id]) onRequestSlot(layer.id); }}
             onEnterCrop={(event) => { if (!slotSources[layer.id]) return; event.cancelBubble = true; setSelectedId(layer.id); setCropModeId(layer.id); }}
             onDragStart={() => startSlotDrag(layer)}
             onDragMove={(event) => moveSlotDrag(layer, event)}
             onDragEnd={(event) => finishSlotDrag(layer, event)}
             onPhotoTransformMove={(payload) => moveCropPhoto(layer, payload)}
             onPhotoTransformEnd={(payload) => finishCropPhoto(layer, payload)}
             onPhotoTransform={(patch) => updatePhotoTransform(layer.id, patch)}
             onChange={(patch) => updateLayer(layer.id, patch)}
           />)}
          {guides.map((guide, index) => <Line key={`${guide.axis}-${guide.value}-${index}`} points={guide.axis === 'x' ? [guide.value, 0, guide.value, composition.height] : [0, guide.value, composition.width, guide.value]} stroke="#e94e37" strokeWidth={1.5 / scale} dash={[6 / scale, 4 / scale]} listening={false}/>) }
          <Transformer
            ref={transformerRef}
            rotateEnabled={false}
            keepRatio={lockAspectRatio}
            flipEnabled={false}
            enabledAnchors={lockAspectRatio
              ? ['top-left','top-right','bottom-left','bottom-right']
              : ['top-left','top-right','bottom-left','bottom-right','middle-left','middle-right','top-center','bottom-center']}
            borderStroke="#e24b35"
            anchorFill="#fff"
            anchorStroke="#e24b35"
            anchorSize={10 / scale}
            borderStrokeWidth={2 / scale}
            boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 20 || Math.abs(newBox.height) < 20) ? oldBox : newBox}
          />
        </Layer>
      </Stage>
    </div>}
  </div>;
}

function UseTemplate({ template, initialFile, autoCopy, onBack, onEdit, notify }) {
  const [session, commitSession, undo, canUndo, redo, canRedo] = useUndoState(() => ({
    composition: structuredClone(template),
    slotSources: {},
    slotNames: {},
    slotTransforms: {}
  }));
  const { composition, slotSources, slotNames, slotTransforms } = session;
  const [result, setResult] = useState('');
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const { zoom, pan, panning, setZoom, zoomAtPointer, beginPan } = useCanvasViewport(1, .5, 3);
  const [selectedId, setSelectedId] = useState(template.layers.find((layer) => layer.type === 'slot')?.id || null);
  const [cropModeId, setCropModeId] = useState(null);
  const [slotDropId, setSlotDropId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [slotContextMenu, setSlotContextMenu] = useState(null);
  const [exportFormat, setExportFormat] = useState('png');
  const [exportScale, setExportScale] = useState(1);
  const [transparent, setTransparent] = useState(false);
  const [lockAspectRatio, setLockAspectRatio] = useState(true);
  const input = useRef();
  const pendingSlot = useRef(null);
  const initialHandled = useRef(false);
  const renderRequest = useRef(0);
  const copyAfterRenderRef = useRef(false);
  const slots = composition.layers.filter((layer) => layer.type === 'slot');
  const cropLayer = composition.layers.find((layer) => layer.id === cropModeId && layer.type === 'slot');
  const cropTransform = cropLayer ? (slotTransforms[cropLayer.id] || { zoom: 1, offsetX: 0, offsetY: 0 }) : null;
  const outputMime = exportFormat === 'jpg' ? 'image/jpeg' : `image/${exportFormat}`;

  const updateLayer = useCallback((id, patch) => {
    commitSession((previous) => ({
      ...previous,
      composition: {
        ...previous.composition,
        layers: previous.composition.layers.map((layer) => layer.id === id ? { ...layer, ...patch } : layer)
      }
    }));
  }, [commitSession]);
  const updatePhotoTransform = useCallback((id, patch) => {
    commitSession((previous) => ({
      ...previous,
      slotTransforms: {
        ...previous.slotTransforms,
        [id]: { zoom: 1, offsetX: 0, offsetY: 0, ...previous.slotTransforms[id], ...patch }
      }
    }));
  }, [commitSession]);
  const tryBack = useCallback(() => {
    if (!canUndo || confirm('当前生成结果有未保存的修改，确定返回模板库吗？')) onBack();
  }, [canUndo, onBack]);

  const replaceSlotSource = useCallback((slotId, dataUrl, name) => {
    copyAfterRenderRef.current = autoCopy;
    commitSession((previous) => ({
      ...previous,
      slotSources: { ...previous.slotSources, [slotId]: dataUrl },
      slotNames: { ...previous.slotNames, [slotId]: name },
      slotTransforms: { ...previous.slotTransforms, [slotId]: { zoom: 1, offsetX: 0, offsetY: 0 } }
    }));
    setSelectedId(slotId);
  }, [autoCopy, commitSession]);

  const pasteClipboardImage = useCallback(async (targetId) => {
    const slotId = targetId || selectedId || composition.layers.find((layer) => layer.type === 'slot')?.id;
    if (!slotId) return notify('模板中没有可替换照片图层', 'error');
    try {
      const dataUrl = await desktop.readClipboardImage();
      if (!dataUrl) return notify('剪贴板中没有图片', 'error');
      replaceSlotSource(slotId, dataUrl, '剪贴板图片');
    } catch (error) {
      notify(`读取剪贴板失败：${error?.message || error}`, 'error');
    }
  }, [composition.layers, notify, replaceSlotSource, selectedId]);

  const nudgeSelectedPhoto = useCallback((key, distance) => {
    const layer = composition.layers.find((item) => item.id === selectedId && item.type === 'slot');
    if (!layer) return;
    const dx = key === 'ArrowLeft' ? -distance : key === 'ArrowRight' ? distance : 0;
    const dy = key === 'ArrowUp' ? -distance : key === 'ArrowDown' ? distance : 0;
    if (cropModeId === layer.id && slotSources[layer.id]) {
      loadImage(slotSources[layer.id]).then((image) => {
        commitSession((previous) => {
          const currentLayer = previous.composition.layers.find((item) => item.id === selectedId && item.type === 'slot');
          if (!currentLayer || !previous.slotSources[selectedId]) return previous;
          const placement = getPhotoPlacement(image, currentLayer, previous.slotTransforms[selectedId]);
          const x = clamp(placement.x + dx, currentLayer.width - placement.width, 0);
          const y = clamp(placement.y + dy, currentLayer.height - placement.height, 0);
          if (x === placement.x && y === placement.y) return previous;
          return {
            ...previous,
            slotTransforms: {
              ...previous.slotTransforms,
              [selectedId]: { zoom: placement.zoom, offsetX: x - placement.centeredX, offsetY: y - placement.centeredY }
            }
          };
        });
      }).catch((error) => notify(`无法微调照片：${error.message}`, 'error'));
      return;
    }
    commitSession((previous) => {
      const currentLayer = previous.composition.layers.find((item) => item.id === selectedId && item.type === 'slot');
      if (!currentLayer) return previous;
      const x = clamp(currentLayer.x + dx, 0, Math.max(0, previous.composition.width - currentLayer.width));
      const y = clamp(currentLayer.y + dy, 0, Math.max(0, previous.composition.height - currentLayer.height));
      if (x === currentLayer.x && y === currentLayer.y) return previous;
      return {
        ...previous,
        composition: {
          ...previous.composition,
          layers: previous.composition.layers.map((item) => item.id === selectedId ? { ...item, x, y } : item)
        }
      };
    });
  }, [commitSession, composition.layers, cropModeId, notify, selectedId, slotSources]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault(); undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && ((event.key.toLowerCase() === 'z' && event.shiftKey) || event.key.toLowerCase() === 'y')) {
        event.preventDefault(); redo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v' && !isTextEditingTarget(event.target)) {
        event.preventDefault(); pasteClipboardImage();
        return;
      }
      if (event.key.startsWith('Arrow') && !event.ctrlKey && !event.metaKey && !event.altKey && !isTextEditingTarget(event.target)) {
        event.preventDefault(); nudgeSelectedPhoto(event.key, event.shiftKey ? 10 : 1);
        return;
      }
      if (event.key === 'Escape' && !event.repeat) {
        event.preventDefault();
        if (cropModeId) { setCropModeId(null); return; }
        tryBack();
      }
    };
    const closeMenu = () => {
      setContextMenu(null);
      setSlotContextMenu(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', closeMenu);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', closeMenu);
    };
  }, [cropModeId, nudgeSelectedPhoto, pasteClipboardImage, redo, tryBack, undo]);

  useEffect(() => {
    if (cropModeId && !slotSources[cropModeId]) setCropModeId(null);
  }, [cropModeId, slotSources]);

  useEffect(() => {
    if (!Object.keys(slotSources).length) { setResult(''); setCopied(false); return; }
    const request = ++renderRequest.current;
    let cancelled = false;
    setWorking(true);
    setCopied(false);
    renderTemplate(composition, slotSources, slotTransforms, { transparent, mime: outputMime }).then(async (dataUrl) => {
      if (cancelled || request !== renderRequest.current) return;
      setResult(dataUrl);
      if (!copyAfterRenderRef.current || !autoCopy) {
        copyAfterRenderRef.current = false;
        setCopied(false);
        return;
      }
      copyAfterRenderRef.current = false;
      try {
        const clipboardDataUrl = outputMime === 'image/png'
          ? undefined
          : await renderTemplate(composition, slotSources, slotTransforms, { transparent, mime: 'image/png' });
        await desktop.copyImage(dataUrl, clipboardDataUrl);
        if (!cancelled && request === renderRequest.current) {
          setCopied(true);
          notify('结果已更新并复制到剪贴板');
        }
      } catch {
        if (!cancelled && request === renderRequest.current) notify('结果已更新，但剪贴板不可用', 'error');
      }
    }).catch((error) => {
      if (!cancelled) notify(`生成失败：${error.message}`, 'error');
    }).finally(() => {
      if (!cancelled && request === renderRequest.current) setWorking(false);
    });
    return () => { cancelled = true; };
  }, [autoCopy, composition, outputMime, slotSources, slotTransforms, transparent, notify]);

  const acceptFile = useCallback(async (file, targetId) => {
    try {
      const slotId = targetId || selectedId || composition.layers.find((layer) => layer.type === 'slot')?.id;
      if (!slotId) return notify('模板中没有可替换照片图层', 'error');
      const dataUrl = await fileToDataUrl(file);
      replaceSlotSource(slotId, dataUrl, file.name);
    } catch (error) { notify(error.message, 'error'); }
  }, [composition.layers, notify, replaceSlotSource, selectedId]);

  const requestSlotImage = useCallback((slotId) => {
    pendingSlot.current = slotId;
    input.current?.click();
  }, []);

  useEffect(() => {
    if (initialFile && !initialHandled.current) {
      initialHandled.current = true;
      acceptFile(initialFile, composition.layers.find((layer) => layer.type === 'slot')?.id);
    }
  }, [acceptFile, composition.layers, initialFile]);

  const currentResult = useCallback(async () => {
    if (!Object.keys(slotSources).length) return '';
    if (working || !result) {
      const dataUrl = await renderTemplate(composition, slotSources, slotTransforms, { transparent, mime: outputMime });
      setResult(dataUrl);
      return dataUrl;
    }
    return result;
  }, [composition, outputMime, result, slotSources, slotTransforms, transparent, working]);

  const copyAgain = useCallback(async () => {
    const dataUrl = await currentResult();
    if (!dataUrl) return;
    try {
      const clipboardDataUrl = outputMime === 'image/png'
        ? undefined
        : await renderTemplate(composition, slotSources, slotTransforms, { transparent, mime: 'image/png' });
      await desktop.copyImage(dataUrl, clipboardDataUrl);
      setCopied(true);
      notify('已复制，可粘贴到聊天窗口或文件夹');
    }
    catch { setCopied(false); notify('剪贴板不可用，请保存 PNG', 'error'); }
  }, [composition, currentResult, notify, outputMime, slotSources, slotTransforms, transparent]);

  const resetCrop = () => { if (cropModeId) updatePhotoTransform(cropModeId, { zoom: 1, offsetX: 0, offsetY: 0 }); };

  const save = async () => {
    if (!Object.keys(slotSources).length) return;
    try {
      const dataUrl = await renderTemplate(composition, slotSources, slotTransforms, { scale: exportScale, mime: outputMime, transparent });
      const path = await desktop.saveImage(dataUrl, `${template.name}-${Date.now()}.${exportFormat}`);
      if (path) notify(`图片已保存为 ${exportFormat.toUpperCase()}`);
    } catch (error) { notify(`保存失败：${error.message}`, 'error'); }
  };

  const dropOnSlot = (event) => {
    const file = Array.from(event.dataTransfer.files || []).find((item) => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    const frame = event.currentTarget.querySelector('.result-canvas-frame');
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const x = (event.clientX - rect.left) * composition.width / rect.width;
    const y = (event.clientY - rect.top) * composition.height / rect.height;
    const target = [...composition.layers].reverse().find((layer) => layer.type === 'slot' && layer.visible && pointInLayer(x, y, layer));
    if (!target) return notify('请把图片拖到高亮的可替换区域', 'error');
    acceptFile(file, target.id);
  };

  const dropOnSlotList = (event, slotId) => {
    event.preventDefault();
    event.stopPropagation();
    setSlotDropId(null);
    const file = Array.from(event.dataTransfer.files || []).find((item) => item.type.startsWith('image/'));
    if (!file) return notify('请拖入图片文件', 'error');
    acceptFile(file, slotId);
  };

  const handleResultWheel = (event) => {
    if (cropModeId && cropLayer && slotSources[cropModeId]) {
      const frame = event.currentTarget.querySelector('.result-canvas-frame');
      const rect = frame?.getBoundingClientRect();
      if (rect) {
        const x = (event.clientX - rect.left) * composition.width / rect.width;
        const y = (event.clientY - rect.top) * composition.height / rect.height;
        if (pointInLayer(x, y, cropLayer)) {
          event.preventDefault();
          event.stopPropagation();
          const nextZoom = wheelZoom(cropTransform.zoom, event.deltaY, 1, 5);
          if (nextZoom !== cropTransform.zoom) updatePhotoTransform(cropLayer.id, { zoom: nextZoom });
          return;
        }
      }
    }
    zoomAtPointer(event);
  };

  const openContextMenu = (event) => {
    if (!result) return;
    event.preventDefault();
    event.stopPropagation();
    setSlotContextMenu(null);
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 166), y: Math.min(event.clientY, window.innerHeight - 52) });
  };

  const openSlotContextMenu = (event, slotId) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(slotId);
    setContextMenu(null);
    setSlotContextMenu({
      id: slotId,
      x: Math.min(event.clientX, window.innerWidth - 166),
      y: Math.min(event.clientY, window.innerHeight - 52)
    });
  };

  return <main className="use-page">
    <header className="editor-topbar">
      <div className="editor-left"><IconButton label="返回模板库" onClick={tryBack}><ArrowLeft size={21}/></IconButton><div className="title-field"><strong>{template.name}</strong><span>使用模板</span></div></div>
      <div className="editor-actions"><IconButton label="撤销 (Ctrl+Z)" onClick={undo} disabled={!canUndo}><Undo2 size={18}/></IconButton><IconButton label="重做 (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}><Redo2 size={18}/></IconButton><button className="secondary-button" onClick={onEdit}><Pencil size={16}/>编辑模板</button></div>
    </header>
    <div className="use-layout">
      <section className="use-sidebar">
        <p className="eyebrow">第 1 步</p><h1>替换照片</h1><p className="use-intro">点击画布中的高亮区域、拖入图片，或按 Ctrl+V 粘贴剪贴板图片。</p>
        <div className="slot-list-heading"><strong>可替换图层</strong><span>{slots.length}</span></div>
        <div className="slot-list">
          {slots.map((layer) => {
            const source = slotSources[layer.id];
            const name = slotNames[layer.id];
            return <div key={layer.id} className={`slot-item-row ${slotDropId === layer.id ? 'dragging' : ''}`} onContextMenu={(event) => openSlotContextMenu(event, layer.id)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setSlotDropId(layer.id); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSlotDropId((current) => current === layer.id ? null : current); }} onDrop={(event) => dropOnSlotList(event, layer.id)}><button type="button" className={`slot-item ${selectedId === layer.id ? 'selected' : ''}`} onClick={() => { setSelectedId(layer.id); requestSlotImage(layer.id); }}>
              <span className={`slot-item-thumb ${source ? 'has-image' : ''}`}>{source ? <img src={source} alt=""/> : <LayerThumb layer={layer}/>}</span>
              <span className="slot-item-copy"><strong>{layer.name}</strong><small>{name || '点击选择图片'}</small></span>
              {source ? <RotateCcw size={16}/> : <ImagePlus size={16}/>}
            </button>{source && <IconButton label={cropModeId === layer.id ? '退出裁切' : '裁切照片'} className={cropModeId === layer.id ? 'active slot-crop-button' : 'slot-crop-button'} onClick={() => { setSelectedId(layer.id); setCropModeId((current) => current === layer.id ? null : layer.id); }}><Crop size={16}/></IconButton>}</div>;
          })}
        </div>
        <label className="check-row"><input type="checkbox" checked={lockAspectRatio} onChange={(event) => setLockAspectRatio(event.target.checked)}/><span>锁定照片宽高比</span></label>
        {cropLayer && slotSources[cropLayer.id] && <div className="crop-controls"><div className="crop-controls-heading"><strong><Crop size={16}/>裁切照片</strong><IconButton label="完成裁切" onClick={() => setCropModeId(null)}><Check size={16}/></IconButton></div><label className="crop-zoom-field"><span>缩放</span><input type="range" min="1" max="5" step="0.05" value={cropTransform.zoom} onChange={(event) => updatePhotoTransform(cropLayer.id, { zoom: Number(event.target.value) })}/><output>{Math.round(cropTransform.zoom * 100)}%</output></label><button className="wide-property-button" onClick={resetCrop}><RotateCcw size={16}/>重置裁切</button></div>}
        <input ref={input} hidden type="file" accept="image/*" onChange={(event) => { if (event.target.files[0]) acceptFile(event.target.files[0], pendingSlot.current); event.target.value = ''; pendingSlot.current = null; }}/>
        <div className="export-settings"><div className="slot-list-heading"><strong>导出设置</strong></div><div className="export-setting-row"><label><span>格式</span><select value={exportFormat} onChange={(event) => { const value = event.target.value; setExportFormat(value); if (value === 'jpg') setTransparent(false); }}><option value="png">PNG</option><option value="jpg">JPEG</option><option value="webp">WebP</option></select></label><label><span>倍率</span><select value={exportScale} onChange={(event) => setExportScale(Number(event.target.value))}><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option></select></label></div><label className="check-row"><input type="checkbox" disabled={exportFormat === 'jpg'} checked={transparent} onChange={(event) => setTransparent(event.target.checked)}/><span>透明画布背景</span></label></div>
      </section>
      <section className="result-area">
        <div className="result-heading"><div><p className="eyebrow">第 2 步</p><h2>生成结果</h2></div><div className="result-heading-actions"><div className="zoom-control"><IconButton label="缩小" onClick={() => setZoom((current) => current - .1)}><ZoomOut size={17}/></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton label="放大" onClick={() => setZoom((current) => current + .1)}><ZoomIn size={17}/></IconButton></div>{result && <div className="result-actions"><button className="secondary-button" onClick={save}><Download size={17}/>保存 {exportFormat.toUpperCase()}</button><button className="primary-button" onClick={copyAgain}>{copied ? <Check size={17}/> : <Copy size={17}/>}复制图片</button></div>}</div></div>
        <div className="result-stage has-result" onWheel={handleResultWheel} onContextMenu={openContextMenu} onDragStart={(event) => event.preventDefault()} onDragOver={(event) => { if (Array.from(event.dataTransfer.types || []).includes('Files')) event.preventDefault(); }} onDrop={dropOnSlot}>
          <UseStage composition={composition} slotSources={slotSources} slotTransforms={slotTransforms} selectedId={selectedId} setSelectedId={setSelectedId} updateLayer={updateLayer} cropModeId={cropModeId} setCropModeId={setCropModeId} updatePhotoTransform={updatePhotoTransform} onRequestSlot={requestSlotImage} zoom={zoom} pan={pan} panning={panning} onPanStart={beginPan} transparent={transparent} lockAspectRatio={lockAspectRatio}/>
        </div>
      </section>
    </div>
    {contextMenu && <div className="result-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button onClick={() => { setContextMenu(null); copyAgain(); }}><Copy size={16}/>复制图片</button></div>}
    {slotContextMenu && <div className="result-context-menu" style={{ left: slotContextMenu.x, top: slotContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button onClick={() => { const slotId = slotContextMenu.id; setSlotContextMenu(null); pasteClipboardImage(slotId); }}><Clipboard size={16}/>粘贴图片</button></div>}
  </main>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
