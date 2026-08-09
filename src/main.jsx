import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import * as XLSX from 'xlsx';
import { Stage, Layer, Group, Ellipse, Image as KonvaImage, Line, Rect, Text as KonvaText, Transformer, Circle as KonvaCircle } from 'react-konva';
import {
  AlignCenter, AlignHorizontalDistributeCenter, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart, AlignLeft, AlignRight, AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, ArrowLeft, Bold, Check, ChevronDown, ChevronRight, ChevronUp,
  BoxSelect, Circle, Clipboard, Copy, Crop, Download, Eye, EyeOff, FileImage, Grid2X2, GripVertical, ImagePlus,
  Eraser, FolderOpen, Italic, Layers3, LayoutTemplate, Lock, Monitor, MoreHorizontal, MousePointer2, PaintBucket, Pencil, Pentagon, Pipette, Plus, Redo2, RefreshCw, RotateCcw, Scissors,
  Save, Settings, Shapes, Sparkles, Square, Star, Strikethrough, Sun, Trash2, Type, Underline, Undo2, Unlock, Upload, Link2,
  X, ZoomIn, ZoomOut
} from 'lucide-react';
import bundledTemplates from './bundled-templates.json';
import './styles.css';

const browserDesktop = {
  isDesktop: false,
  loadConfig: async () => ({ theme: 'system', autoCopy: true }),
  saveConfig: async (value) => localStorage.setItem('meme-helper-config', JSON.stringify(value)),
  loadTemplates: async () => JSON.parse(localStorage.getItem('meme-helper-templates') || '[]'),
  listTemplateFolders: async () => [],
  saveTemplates: async (value) => localStorage.setItem('meme-helper-templates', JSON.stringify(value)),
  loadEditorDrafts: async () => JSON.parse(localStorage.getItem('meme-helper-editor-drafts') || '{}'),
  saveEditorDrafts: async (value) => localStorage.setItem('meme-helper-editor-drafts', JSON.stringify(value)),
  loadUseSessions: async () => JSON.parse(localStorage.getItem('meme-helper-use-sessions') || '{}'),
  saveUseSessions: async (value) => localStorage.setItem('meme-helper-use-sessions', JSON.stringify(value)),
  decodeGifFrames: async (dataUrl) => {
    const image = await loadImage(dataUrl);
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return { width: image.width, height: image.height, frames: [{ dataUrl: canvas.toDataURL('image/png'), delayMs: 100, width: image.width, height: image.height }] };
  },
  encodeGifFrames: async (frames) => frames[0]?.dataUrl || '',
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
  },
  openTemplateFolder: async () => false,
  downloadGroupFaces: async () => { throw new Error('群名单头像下载仅支持桌面版'); }
};

const desktop = window.__TAURI_INTERNALS__ ? {
  isDesktop: true,
  loadConfig: () => invoke('load_config'),
  saveConfig: (config) => invoke('save_config', { config }),
  loadTemplates: () => invoke('load_templates'),
  listTemplateFolders: () => invoke('list_template_folders'),
  saveTemplates: (templates) => invoke('save_templates', { templates }),
  loadEditorDrafts: () => invoke('load_editor_drafts'),
  saveEditorDrafts: (drafts) => invoke('save_editor_drafts', { drafts }),
  loadUseSessions: () => invoke('load_use_sessions'),
  saveUseSessions: (sessions) => invoke('save_use_sessions', { sessions }),
  copyImages: (dataUrls) => invoke('copy_images', { dataUrls }),
  decodeGifFrames: (dataUrl) => invoke('decode_gif_frames', { dataUrl }),
  encodeGifFrames: (frames, loopCount = null) => invoke('encode_gif_frames', { frames, loopCount }),
  copyImage: (dataUrl, clipboardDataUrl) => invoke('copy_image', { dataUrl, clipboardDataUrl }),
  readClipboardImage: () => invoke('read_clipboard_image'),
  saveImage: (dataUrl, suggestedName) => invoke('save_image', { dataUrl, suggestedName }),
  openTemplateFolder: (templateId) => invoke('open_template_folder', { templateId }),
  downloadGroupFaces: (workerIds) => invoke('download_group_faces', { workerIds })
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
const cornerRadiusOf = (layer) => clamp(
  Number(layer.cornerRadius ?? 36),
  0,
  Math.max(0, Math.min(Number(layer.width) || 0, Number(layer.height) || 0) / 2)
);
const POLYGON_MIN_SIDES = 3;
const POLYGON_MAX_SIDES = 12;
const TEXT_STYLE_KEYS = ['fontSize', 'fontFamily', 'fontStyle', 'textDecoration', 'fill', 'stroke', 'strokeWidth', 'lineHeight'];
const TEXT_SIZE_MIN = 0;
const TEXT_SIZE_MAX = 1296;
const TEXT_ITALIC_SHEAR = Math.tan(14 * Math.PI / 180);
const ROTATION_SNAPS = Array.from({ length: 9 }, (_, index) => index * 45);
const wheelZoom = (current, deltaY, min, max) => deltaY === 0
  ? current
  : clamp(Math.round(current * (deltaY < 0 ? 1.1 : .9) * 100) / 100, min, max);

const isTextEditingTarget = (target) => target instanceof HTMLElement && (
  target.isContentEditable
  || ['TEXTAREA', 'SELECT'].includes(target.tagName)
  || (target.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'file', 'hidden'].includes(target.type))
);

function regularPolygonPoints(sides = 5) {
  const count = clamp(Math.round(sides), POLYGON_MIN_SIDES, POLYGON_MAX_SIDES);
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    return { x: .5 + Math.cos(angle) * .5, y: .5 + Math.sin(angle) * .5 };
  });
}

function polygonPointsOf(layer, sides = layer.polygonSides || 5) {
  const count = clamp(Math.round(sides), POLYGON_MIN_SIDES, POLYGON_MAX_SIDES);
  return Array.isArray(layer.polygonPoints) && layer.polygonPoints.length === count
    ? layer.polygonPoints.map((point) => ({ x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) }))
    : regularPolygonPoints(count);
}

function polygonPixelPoints(layer) {
  return polygonPointsOf(layer).flatMap((point) => [point.x * layer.width, point.y * layer.height]);
}

function polygonRadiusPercent(point) {
  const angle = Math.atan2(point.y - .5, point.x - .5);
  const dx = Math.cos(angle); const dy = Math.sin(angle);
  const maximum = Math.min(Math.abs(dx) < 1e-6 ? Infinity : .5 / Math.abs(dx), Math.abs(dy) < 1e-6 ? Infinity : .5 / Math.abs(dy));
  const distance = Math.hypot(point.x - .5, point.y - .5);
  return Math.round(clamp(distance / maximum * 100, 10, 100));
}

function polygonPointAtRadius(point, percent) {
  const angle = Math.atan2(point.y - .5, point.x - .5);
  const dx = Math.cos(angle); const dy = Math.sin(angle);
  const maximum = Math.min(Math.abs(dx) < 1e-6 ? Infinity : .5 / Math.abs(dx), Math.abs(dy) < 1e-6 ? Infinity : .5 / Math.abs(dy));
  const distance = maximum * clamp(percent, 10, 100) / 100;
  return { x: clamp(.5 + dx * distance, 0, 1), y: clamp(.5 + dy * distance, 0, 1) };
}

function layerBounds(layer) {
  const radians = (Number(layer.rotation) || 0) * Math.PI / 180;
  const cosine = Math.cos(radians); const sine = Math.sin(radians);
  const corners = [[0, 0], [layer.width, 0], [layer.width, layer.height], [0, layer.height]].map(([x, y]) => ({
    x: layer.x + x * cosine - y * sine,
    y: layer.y + x * sine + y * cosine
  }));
  const xs = corners.map((point) => point.x); const ys = corners.map((point) => point.y);
  const left = Math.min(...xs); const top = Math.min(...ys);
  const right = Math.max(...xs); const bottom = Math.max(...ys);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function combinedLayerBounds(layers) {
  if (!layers.length) return null;
  const bounds = layers.map(layerBounds);
  const left = Math.min(...bounds.map((item) => item.left));
  const top = Math.min(...bounds.map((item) => item.top));
  const right = Math.max(...bounds.map((item) => item.right));
  const bottom = Math.max(...bounds.map((item) => item.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function baseTextStyle(layer) {
  return {
    fontSize: clamp(layer.fontSize ?? 48, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
    fontFamily: layer.fontFamily || 'Microsoft YaHei',
    fontStyle: layer.fontStyle || 'normal',
    textDecoration: layer.textDecoration || '',
    fill: layer.fill || '#22211f',
    stroke: layer.stroke || '#ffffff',
    strokeWidth: Math.max(0, Number(layer.strokeWidth) || 0),
    lineHeight: Math.max(0, Number(layer.lineHeight ?? 1.25))
  };
}

function textStyleAt(layer, index) {
  const style = baseTextStyle(layer);
  (layer.textRuns || []).forEach((run) => {
    if (index >= run.start && index < run.end) Object.assign(style, run.style || {});
  });
  return style;
}

function compressTextStyles(layer, styles) {
  const runs = [];
  styles.forEach((style, index) => {
    const previous = runs.at(-1);
    const key = JSON.stringify(style);
    if (previous?.key === key) previous.end = index + 1;
    else runs.push({ start: index, end: index + 1, style, key });
  });
  return runs.map(({ start, end, style }) => ({ start, end, style }));
}

function applyTextStyle(layer, selection, patch) {
  const text = String(layer.text || '');
  const start = clamp(Math.min(selection?.start ?? 0, selection?.end ?? 0), 0, text.length);
  const end = clamp(Math.max(selection?.start ?? 0, selection?.end ?? 0), 0, text.length);
  if (start === end) {
    const nextRuns = (layer.textRuns || []).map((run) => ({
      ...run,
      style: Object.fromEntries(Object.entries(run.style || {}).filter(([key]) => !(key in patch)))
    })).filter((run) => Object.keys(run.style).length);
    return { ...patch, textRuns: nextRuns };
  }
  const styles = Array.from({ length: text.length }, (_, index) => textStyleAt(layer, index));
  for (let index = start; index < end; index += 1) styles[index] = { ...styles[index], ...patch };
  return { textRuns: compressTextStyles(layer, styles) };
}

function updateTextContent(layer, text) {
  const previous = String(layer.text || '');
  const next = String(text);
  if (previous === next) return { text: next };
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const inherited = textStyleAt(layer, Math.max(0, prefix - 1));
  const styles = [
    ...Array.from({ length: prefix }, (_, index) => textStyleAt(layer, index)),
    ...Array.from({ length: next.length - prefix - suffix }, () => ({ ...inherited })),
    ...Array.from({ length: suffix }, (_, index) => textStyleAt(layer, previous.length - suffix + index))
  ];
  return { text: next, textRuns: compressTextStyles(layer, styles) };
}

function renderedTextFontStyle(style) {
  const tokens = new Set(String(style.fontStyle || '').split(/\s+/).filter(Boolean));
  return tokens.has('bold') ? 'bold' : 'normal';
}

function isItalicTextStyle(style) {
  return String(style.fontStyle || '').split(/\s+/).includes('italic');
}

function textFontString(style) {
  return `${renderedTextFontStyle(style)} ${Math.max(.01, style.fontSize)}px "${style.fontFamily || 'Microsoft YaHei'}"`;
}

function measureTextLayer(layer) {
  const text = String(layer.text || '');
  const padding = Math.max(0, Number(layer.backgroundPadding) || 0);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const lines = [[]];
  let offset = 0;
  for (const character of text) {
    if (character === '\n') lines.push([]);
    else lines.at(-1).push({ character, style: textStyleAt(layer, offset) });
    offset += character.length;
  }
  let width = 0;
  let height = 0;
  if (layer.textOrientation === 'vertical') {
    lines.forEach((glyphs) => {
      let columnWidth = 0;
      let columnHeight = 0;
      if (!glyphs.length) { const style = baseTextStyle(layer); columnWidth = style.fontSize * style.lineHeight; columnHeight = style.fontSize * style.lineHeight; }
      glyphs.forEach(({ style }) => { const step = style.fontSize * style.lineHeight; const italicOverhang = isItalicTextStyle(style) ? style.fontSize * TEXT_ITALIC_SHEAR : 0; columnWidth = Math.max(columnWidth, step + italicOverhang); columnHeight += step; });
      width += columnWidth;
      height = Math.max(height, columnHeight);
    });
  } else {
    lines.forEach((glyphs) => {
      let lineWidth = 0; let lineHeight = 0; let italicOverhang = 0;
      if (!glyphs.length) { const style = baseTextStyle(layer); lineHeight = style.fontSize * style.lineHeight; }
      glyphs.forEach(({ character, style }) => { ctx.font = textFontString(style); lineWidth += ctx.measureText(character).width; lineHeight = Math.max(lineHeight, style.fontSize * style.lineHeight); if (isItalicTextStyle(style)) italicOverhang = Math.max(italicOverhang, style.fontSize * TEXT_ITALIC_SHEAR); });
      width = Math.max(width, lineWidth + italicOverhang); height += lineHeight;
    });
  }
  const maxStroke = Math.max(...Array.from({ length: text.length || 1 }, (_, index) => textStyleAt(layer, Math.min(index, Math.max(0, text.length - 1))).strokeWidth * 2));
  const shadowBlur = layer.shadowEnabled ? Math.max(0, Number(layer.shadowBlur) || 0) : 0;
  const shadowWidth = shadowBlur + (layer.shadowEnabled ? Math.abs(Number(layer.shadowOffsetX) || 0) : 0);
  const shadowHeight = shadowBlur + (layer.shadowEnabled ? Math.abs(Number(layer.shadowOffsetY) || 0) : 0);
  return { width: Math.max(1, Math.ceil(width + padding * 2 + 2 + maxStroke + shadowWidth)), height: Math.max(1, Math.ceil(height + padding * 2 + 2 + maxStroke + shadowHeight)) };
}

function fitTextLayerToContent(layer) {
  return layer.type === 'text' ? { ...layer, ...measureTextLayer(layer) } : layer;
}

function layoutStyledText(layer) {
  const text = String(layer.text || '');
  const padding = Math.max(0, Number(layer.backgroundPadding) || 0);
  const availableWidth = Math.max(1, layer.width - padding * 2);
  const availableHeight = Math.max(1, layer.height - padding * 2);
  const requestedSize = clamp(layer.fontSize ?? 48, TEXT_SIZE_MIN, TEXT_SIZE_MAX);
  const fontScale = requestedSize > 0 ? resolveTextFontSize(layer) / requestedSize : 1;
  const effectiveBaseSize = requestedSize * fontScale;
  if (layer.textOrientation === 'vertical') {
    const columns = [[]]; let offset = 0;
    for (const character of text) { if (character === '\n') columns.push([]); else { const style = { ...textStyleAt(layer, offset) }; style.fontSize = clamp(style.fontSize * fontScale, TEXT_SIZE_MIN, TEXT_SIZE_MAX); columns.at(-1).push({ character, style }); } offset += character.length; }
    const metrics = columns.map((glyphs) => ({ glyphs, width: Math.max(effectiveBaseSize, ...glyphs.map(({ style }) => style.fontSize * style.lineHeight)), height: glyphs.reduce((sum, { style }) => sum + style.fontSize * style.lineHeight, 0) }));
    const runs = []; let x = layer.width - padding;
    metrics.forEach((column) => { x -= column.width; let y = padding + (layer.align === 'center' ? Math.max(0, (availableHeight - column.height) / 2) : layer.align === 'right' ? Math.max(0, availableHeight - column.height) : 0); column.glyphs.forEach(({ character, style }) => { runs.push({ text: character, x, y, width: column.width, style, key: JSON.stringify(style), lineY: y }); y += style.fontSize * style.lineHeight; }); });
    return runs;
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const lines = [];
  let line = { glyphs: [], width: 0, height: 0 };
  const pushLine = () => {
    if (!line.glyphs.length) line.height = effectiveBaseSize * (layer.lineHeight ?? 1.25);
    lines.push(line);
    line = { glyphs: [], width: 0, height: 0 };
  };
  let textOffset = 0;
  [...text].forEach((character) => {
    if (character === '\n') { textOffset += character.length; pushLine(); return; }
    const style = { ...textStyleAt(layer, textOffset) };
    style.fontSize = clamp(style.fontSize * fontScale, TEXT_SIZE_MIN, TEXT_SIZE_MAX);
    ctx.font = textFontString(style);
    const width = ctx.measureText(character).width;
    if (line.glyphs.length && line.width + width > availableWidth) pushLine();
    line.glyphs.push({ character, width, style });
    line.width += width;
    line.height = Math.max(line.height, style.fontSize * style.lineHeight);
    textOffset += character.length;
  });
  pushLine();
  const runs = [];
  let y = padding;
  for (const current of lines) {
    if (y >= padding + availableHeight) break;
    let x = padding + (layer.align === 'center' ? (availableWidth - current.width) / 2 : layer.align === 'right' ? availableWidth - current.width : 0);
    current.glyphs.forEach((glyph) => {
      const previous = runs.at(-1);
      const key = JSON.stringify(glyph.style);
      if (previous && previous.key === key && previous.lineY === y && Math.abs(previous.x + previous.width - x) < .01) {
        previous.text += glyph.character; previous.width += glyph.width;
      } else runs.push({ text: glyph.character, x, y, width: glyph.width, style: glyph.style, key, lineY: y });
      x += glyph.width;
    });
    y += current.height;
  }
  return runs;
}

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
      { id: uid(), name: '底图与文字', type: 'static', src: office, x: 0, y: 0, width: 800, height: 800, rotation: 0, opacity: 1, blendMode: 'source-over', aspectRatioLocked: true, visible: true, fit: 'fill' },
      { id: uid(), name: '人物照片', type: 'slot', src: '', x: 116, y: 150, width: 568, height: 400, rotation: 0, opacity: 1, blendMode: 'source-over', aspectRatioLocked: true, visible: true, fit: 'cover' }
    ]},
    { id: uid(), name: '需求来了', width: 900, height: 600, createdAt: now, updatedAt: now, layers: [
      { id: uid(), name: '黑色边框', type: 'static', src: reaction, x: 0, y: 0, width: 900, height: 600, rotation: 0, opacity: 1, blendMode: 'source-over', aspectRatioLocked: true, visible: true, fit: 'fill' },
      { id: uid(), name: '反应照片', type: 'slot', src: '', x: 92, y: 125, width: 716, height: 350, rotation: 0, opacity: 1, blendMode: 'source-over', aspectRatioLocked: true, visible: true, fit: 'cover' }
    ]}
  ];
}

const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'tif', 'tiff', 'ico']);

function imageMimeFromBytes(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const ascii = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  if ((ascii(0, 4) === 'II*\0') || (ascii(0, 4) === 'MM\0*')) return 'image/tiff';
  const text = new TextDecoder().decode(bytes.slice(0, 512)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'image/svg+xml';
  return null;
}

function isGifBytes(bytes) {
  return Boolean(bytes && bytes.length >= 6 && (
    String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a'
    || String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a'
  ));
}

function isImageFileLike(file) {
  const extension = String(file?.name || '').split('.').pop()?.toLowerCase();
  return Boolean(file && (file.type?.startsWith('image/') || IMAGE_FILE_EXTENSIONS.has(extension)));
}

function dataUrlToFile(dataUrl, name = '图片.png') {
  const separator = String(dataUrl || '').indexOf(',');
  if (separator < 0) throw new Error('GIF 帧数据无效');
  const header = String(dataUrl).slice(0, separator);
  const payload = String(dataUrl).slice(separator + 1);
  const mime = header.match(/^data:([^;,]+)/i)?.[1] || 'image/png';
  let bytes;
  if (/;base64/i.test(header)) {
    const binary = atob(payload);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return new File([bytes], name, { type: mime });
}

async function fileToDataUrl(file) {
  const extension = String(file?.name || '').split('.').pop()?.toLowerCase();
  if (!isImageFileLike(file)) {
    throw new Error('请选择图片文件');
  }
  const prefix = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const detectedMime = imageMimeFromBytes(prefix);
  const claimsGif = file.type?.toLowerCase() === 'image/gif' || extension === 'gif';
  if (claimsGif && !isGifBytes(prefix) && !detectedMime) {
    throw new Error('该文件扩展名为 GIF，但不是有效的 GIF87a/GIF89a 图片');
  }
  const blob = detectedMime && detectedMime !== file.type
    ? new Blob([file], { type: detectedMime })
    : file;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(blob);
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

async function normalizeStaticImageDataUrl(source) {
  const image = await loadImage(source);
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
}

async function createGifSourceFromImage(source) {
  const png = await normalizeStaticImageDataUrl(source);
  const encoded = await desktop.encodeGifFrames([{ dataUrl: png, delayMs: 100 }], null);
  if (!isGifDataUrl(encoded)) throw new Error('GIF 编码失败，请重新选择图片');
  return encoded;
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

function multiPhotoLayoutOf(layer) {
  return ['horizontal', 'vertical', 'grid'].includes(layer?.multiPhotoLayout) ? layer.multiPhotoLayout : 'none';
}

function isReplaceableSlot(layer) {
  return layer?.type === 'slot' && !layer.replacementDisabled && !layer.boundLayerId && !layer.slotFill;
}

const MULTI_PHOTO_LAYOUT_LABELS = { horizontal: '横向排列', vertical: '纵向排列', grid: '网格换行' };

function multiPhotoLayoutLabel(layer) {
  return MULTI_PHOTO_LAYOUT_LABELS[multiPhotoLayoutOf(layer)] || '';
}

function multiPhotoExpandedSize(layer, count, baseLayer = layer) {
  const total = Math.max(1, Number(count) || 1);
  const layout = multiPhotoLayoutOf(layer);
  const unitWidth = Math.max(1, Number(baseLayer?.width) || Number(layer.width) || 1);
  const unitHeight = Math.max(1, Number(baseLayer?.height) || Number(layer.height) || 1);
  if (layout === 'horizontal') return { width: unitWidth * total, height: unitHeight, multiPhotoCellWidth: unitWidth, multiPhotoCellHeight: unitHeight, multiPhotoCount: total };
  if (layout === 'vertical') return { width: unitWidth, height: unitHeight * total, multiPhotoCellWidth: unitWidth, multiPhotoCellHeight: unitHeight, multiPhotoCount: total };
  if (layout === 'grid') {
    const columns = clamp(Number(layer.multiPhotoColumns) || 2, 1, Math.max(1, Math.min(12, total)));
    const rows = Math.ceil(total / columns);
    return { width: unitWidth * columns, height: unitHeight * rows, multiPhotoCellWidth: unitWidth, multiPhotoCellHeight: unitHeight, multiPhotoCount: total };
  }
  return { width: unitWidth, height: unitHeight, multiPhotoCellWidth: undefined, multiPhotoCellHeight: undefined, multiPhotoCount: undefined };
}

function resizeMultiPhotoSlot(composition, template, slotId, count) {
  const baseLayer = template.layers?.find((layer) => layer.id === slotId) || composition.layers?.find((layer) => layer.id === slotId);
  if (!baseLayer) return composition;
  return {
    ...composition,
    layers: composition.layers.map((layer) => layer.id === slotId ? { ...layer, ...multiPhotoExpandedSize(layer, count, baseLayer) } : layer)
  };
}

function multiPhotoCells(layer, count) {
  const total = Math.max(1, Number(count) || 1);
  const layout = multiPhotoLayoutOf(layer);
  if (layout === 'none' || total === 1) return [{ x: 0, y: 0, width: layer.width, height: layer.height }];
  const unitWidth = Math.max(1, Number(layer.multiPhotoCellWidth) || Number(layer.width) || 1);
  const unitHeight = Math.max(1, Number(layer.multiPhotoCellHeight) || Number(layer.height) || 1);
  if (layout === 'horizontal') {
    return Array.from({ length: total }, (_, index) => ({ x: index * unitWidth, y: 0, width: unitWidth, height: unitHeight }));
  }
  if (layout === 'vertical') {
    return Array.from({ length: total }, (_, index) => ({ x: 0, y: index * unitHeight, width: unitWidth, height: unitHeight }));
  }
  const columns = clamp(Number(layer.multiPhotoColumns) || 2, 1, Math.max(1, Math.min(12, total)));
  return Array.from({ length: total }, (_, index) => ({ x: (index % columns) * unitWidth, y: Math.floor(index / columns) * unitHeight, width: unitWidth, height: unitHeight }));
}

async function drawMultiPhotoSources(ctx, layer, sources, signal) {
  const validSources = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  if (!validSources.length) return;
  const cells = multiPhotoCells(layer, validSources.length);
  for (let index = 0; index < validSources.length; index += 1) {
    if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
    const image = await loadImage(validSources[index]);
    const cell = cells[index] || cells[cells.length - 1];
    if (layer.fit === 'cover') {
      const crop = getCoverCrop(image, cell.width, cell.height);
      ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, cell.x, cell.y, cell.width, cell.height);
    } else {
      ctx.drawImage(image, 0, 0, image.width, image.height, cell.x, cell.y, cell.width, cell.height);
    }
  }
}

function parseFrameList(value) {
  if (Array.isArray(value)) return value.map(Number).filter((item) => Number.isInteger(item) && item > 0);
  return String(value || '').split(/[.,，、\s]+/).map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0);
}

function isLayerVisibleAtFrame(layer, frameIndex) {
  if (!Number.isInteger(frameIndex) || frameIndex < 1) return true;
  const frames = parseFrameList(layer.visibleFrames);
  return !frames.length || frames.includes(frameIndex);
}

function layerSourceForRender(layer, replacements = {}) {
  if (layer.type !== 'slot') return layer.src || '';
  if (layer.slotFill) return '';
  const boundSource = layer.boundLayerId ? replacements[layer.boundLayerId] : undefined;
  return replacements[layer.id] || boundSource || (layer.replacementDisabled ? '' : layer.src) || '';
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
    const radius = cornerRadiusOf(layer);
    ctx.moveTo(radius, 0); ctx.lineTo(width - radius, 0);
    ctx.quadraticCurveTo(width, 0, width, radius); ctx.lineTo(width, height - radius);
    ctx.quadraticCurveTo(width, height, width - radius, height); ctx.lineTo(radius, height);
    ctx.quadraticCurveTo(0, height, 0, height - radius); ctx.lineTo(0, radius);
    ctx.quadraticCurveTo(0, 0, radius, 0);
  } else if (shape === 'polygon') {
    polygonPointsOf(layer).forEach((point, index) => {
      const x = point.x * width; const y = point.y * height;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
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
  const requested = clamp(layer.fontSize ?? 48, TEXT_SIZE_MIN, TEXT_SIZE_MAX);
  if (!layer.autoFit || requested <= 0) return requested;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const padding = Math.max(0, Number(layer.backgroundPadding) || 0);
  const availableWidth = Math.max(1, layer.width - padding * 2);
  const availableHeight = Math.max(1, layer.height - padding * 2);
  const fits = (scale) => {
    let lineWidth = 0;
    let lineHeight = 0;
    let totalHeight = 0;
    let hasGlyphs = false;
    let offset = 0;
    const finishLine = () => {
      totalHeight += hasGlyphs ? lineHeight : requested * scale * (layer.lineHeight ?? 1.25);
      lineWidth = 0; lineHeight = 0; hasGlyphs = false;
    };
    for (const character of String(layer.text || '')) {
      if (character === '\n') { finishLine(); offset += character.length; continue; }
      const style = { ...textStyleAt(layer, offset), fontSize: textStyleAt(layer, offset).fontSize * scale };
      ctx.font = textFontString(style);
      const width = ctx.measureText(character).width;
      if (hasGlyphs && lineWidth + width > availableWidth) finishLine();
      lineWidth += width;
      lineHeight = Math.max(lineHeight, style.fontSize * style.lineHeight);
      hasGlyphs = true;
      offset += character.length;
    }
    finishLine();
    return totalHeight <= availableHeight;
  };
  if (fits(1)) return requested;
  let low = 0; let high = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle; else high = middle;
  }
  return requested * low;
}

function drawTextLayer(ctx, layer) {
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  if (layer.background) {
    ctx.save();
    ctx.fillStyle = layer.background;
    ctx.fillRect(0, 0, layer.width, layer.height);
    ctx.restore();
  }
  layoutStyledText(layer).forEach((run) => {
    const style = run.style;
    const italic = isItalicTextStyle(style);
    const italicOffset = italic ? style.fontSize * TEXT_ITALIC_SHEAR : 0;
    ctx.save();
    ctx.font = textFontString(style);
    if (italic) ctx.transform(1, 0, -TEXT_ITALIC_SHEAR, 1, run.x + italicOffset, run.y);
    else ctx.translate(run.x, run.y);
    ctx.fillStyle = style.fill;
    if (layer.shadowEnabled) {
      ctx.shadowColor = layer.shadowColor || '#000000';
      ctx.shadowBlur = Math.max(0, Number(layer.shadowBlur) || 0);
      ctx.shadowOffsetX = Number(layer.shadowOffsetX) || 0;
      ctx.shadowOffsetY = Number(layer.shadowOffsetY) || 0;
    }
    if (style.strokeWidth > 0) {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.strokeWidth * 2;
      ctx.lineJoin = 'round';
      ctx.strokeText(run.text, 0, 0);
    }
    ctx.fillText(run.text, 0, 0);
    ctx.restore();
    const decorations = String(style.textDecoration || '').split(' ');
    ctx.strokeStyle = style.fill; ctx.lineWidth = Math.max(1, style.fontSize / 18);
    const decorationEnd = run.x + run.width + italicOffset;
    if (decorations.includes('underline')) { ctx.beginPath(); ctx.moveTo(run.x, run.y + style.fontSize * 1.05); ctx.lineTo(decorationEnd, run.y + style.fontSize * 1.05); ctx.stroke(); }
    if (decorations.includes('line-through')) { ctx.beginPath(); ctx.moveTo(run.x, run.y + style.fontSize * .55); ctx.lineTo(decorationEnd, run.y + style.fontSize * .55); ctx.stroke(); }
  });
}

async function drawPaintOverlay(ctx, layer) {
  if (!layer.paintSrc) return;
  const image = await loadImage(layer.paintSrc);
  ctx.drawImage(image, 0, 0, layer.width, layer.height);
}

async function drawMosaicOverlay(ctx, layer) {
  if (!layer.mosaicSrc) return;
  const image = await loadImage(layer.mosaicSrc);
  ctx.drawImage(image, 0, 0, layer.width, layer.height);
}

async function drawEraseMask(ctx, layer) {
  if (!layer.eraseSrc) return;
  const image = await loadImage(layer.eraseSrc);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(image, 0, 0, layer.width, layer.height);
  ctx.restore();
}

function layerEffectInsets(layer) {
  const border = borderWidthOf(layer);
  if (layer.type !== 'text') return { left: border, top: border, right: border, bottom: border };
  const text = String(layer.text || '');
  const stroke = Math.max(...Array.from({ length: text.length || 1 }, (_, index) => textStyleAt(layer, Math.min(index, Math.max(0, text.length - 1))).strokeWidth));
  const blur = layer.shadowEnabled ? Math.max(0, Number(layer.shadowBlur) || 0) : 0;
  const offsetX = layer.shadowEnabled ? Number(layer.shadowOffsetX) || 0 : 0;
  const offsetY = layer.shadowEnabled ? Number(layer.shadowOffsetY) || 0 : 0;
  return {
    left: Math.ceil(border + stroke + Math.max(0, blur - offsetX)),
    top: Math.ceil(border + stroke + Math.max(0, blur - offsetY)),
    right: Math.ceil(border + stroke + Math.max(0, blur + offsetX)),
    bottom: Math.ceil(border + stroke + Math.max(0, blur + offsetY))
  };
}

function borderWidthOf(layer) {
  return Math.max(0, Number(layer.borderWidth) || 0);
}

const LAYER_BLEND_MODES = [
  { value: 'source-over', label: '正常' },
  { value: 'multiply', label: '正片叠底' },
  { value: 'screen', label: '滤色' },
  { value: 'overlay', label: '叠加' },
  { value: 'darken', label: '变暗' },
  { value: 'lighten', label: '变亮' },
  { value: 'color-dodge', label: '颜色减淡' },
  { value: 'color-burn', label: '颜色加深' },
  { value: 'hard-light', label: '强光' },
  { value: 'soft-light', label: '柔光' },
  { value: 'difference', label: '差值' },
  { value: 'exclusion', label: '排除' },
  { value: 'hue', label: '色相' },
  { value: 'saturation', label: '饱和度' },
  { value: 'color', label: '颜色' },
  { value: 'luminosity', label: '明度' }
];
const LAYER_BLEND_MODE_VALUES = new Set(LAYER_BLEND_MODES.map((option) => option.value));

function layerOpacityOf(layer) {
  const value = Number(layer?.opacity);
  return Number.isFinite(value) ? clamp(value, 0, 1) : 1;
}

function layerBlendModeOf(layer) {
  return LAYER_BLEND_MODE_VALUES.has(layer?.blendMode) ? layer.blendMode : 'source-over';
}

function layerCssBlendModeOf(layer) {
  const mode = layerBlendModeOf(layer);
  return mode === 'source-over' ? 'normal' : mode;
}

function aspectRatioLockedOf(layer) {
  return layer?.aspectRatioLocked !== false;
}

function drawLayerBorder(ctx, layer) {
  const borderWidth = borderWidthOf(layer);
  if (!borderWidth) return;
  const multiCount = Math.max(0, Number(layer.multiPhotoCount) || 0);
  if (layer.type === 'slot' && multiPhotoLayoutOf(layer) !== 'none' && multiCount > 1) {
    multiPhotoCells(layer, multiCount).forEach((cell) => {
      ctx.save();
      ctx.translate(cell.x, cell.y);
      drawLayerBorder(ctx, { ...layer, width: cell.width, height: cell.height, multiPhotoCount: 1, multiPhotoCellWidth: undefined, multiPhotoCellHeight: undefined });
      ctx.restore();
    });
    return;
  }
  ctx.save();
  ctx.strokeStyle = layer.borderColor || '#000000';
  ctx.lineWidth = borderWidth;
  ctx.lineJoin = 'round';
  if (layer.type === 'slot') {
    const scaleX = layer.width > 0 ? (layer.width + borderWidth) / layer.width : 1;
    const scaleY = layer.height > 0 ? (layer.height + borderWidth) / layer.height : 1;
    ctx.translate(layer.width / 2, layer.height / 2);
    ctx.scale(scaleX, scaleY);
    ctx.translate(-layer.width / 2, -layer.height / 2);
    traceLayerShape(ctx, layer);
    ctx.stroke();
  } else {
    ctx.strokeRect(-borderWidth / 2, -borderWidth / 2, layer.width + borderWidth, layer.height + borderWidth);
  }
  ctx.restore();
}

async function renderIsolatedLayer(layer, source, photoTransform, paintSource, eraseSource, scale = 1, mosaicSource = null) {
  const insets = layerEffectInsets(layer);
  const logicalWidth = layer.width + insets.left + insets.right;
  const logicalHeight = layer.height + insets.top + insets.bottom;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(logicalWidth * scale));
  canvas.height = Math.max(1, Math.round(logicalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(insets.left, insets.top);
  const drawSource = source ?? layer.src;
  const shapeClipped = layer.type === 'slot';
  if (shapeClipped) { ctx.save(); traceLayerShape(ctx, layer); ctx.clip(); }
  if (layer.type === 'text') drawTextLayer(ctx, layer);
  else if (drawSource) {
    const image = await loadImage(drawSource);
    if (layer.type === 'slot' && source) {
      const placement = getPhotoPlacement(image, layer, photoTransform);
      ctx.drawImage(image, 0, 0, image.width, image.height, placement.x, placement.y, placement.width, placement.height);
    } else if (layer.fit === 'cover') {
      const crop = getCoverCrop(image, layer.width, layer.height);
      ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, layer.width, layer.height);
    } else ctx.drawImage(image, 0, 0, layer.width, layer.height);
  } else if (layer.type === 'slot') {
    if (layer.slotFill) {
      ctx.fillStyle = layer.slotFill;
      traceLayerShape(ctx, layer);
      ctx.fill();
    } else if (!layer.replacementDisabled) {
      ctx.fillStyle = '#e8e6df';
      traceLayerShape(ctx, layer);
      ctx.fill();
      ctx.strokeStyle = '#9d9b94'; ctx.lineWidth = 3; ctx.setLineDash([10, 8]);
      traceLayerShape(ctx, layer); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  if (paintSource) ctx.drawImage(paintSource, 0, 0, layer.width, layer.height);
  else await drawPaintOverlay(ctx, layer);
  if (mosaicSource) ctx.drawImage(mosaicSource, 0, 0, layer.width, layer.height);
  else await drawMosaicOverlay(ctx, layer);
  if (eraseSource) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(eraseSource, 0, 0, layer.width, layer.height);
    ctx.restore();
  } else await drawEraseMask(ctx, layer);
  if (shapeClipped) ctx.restore();
  drawLayerBorder(ctx, layer);
  return { canvas, insets, logicalWidth, logicalHeight };
}

async function renderTemplate(template, replacements, photoTransforms = {}, options = {}) {
  const signal = typeof options === 'object' ? options.signal : null;
  if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
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
  const frameIndex = Number.isInteger(options.frameIndex) ? options.frameIndex : null;
  for (const layer of template.layers) {
    if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
    if (!layer.visible || !isLayerVisibleAtFrame(layer, frameIndex)) continue;
    ctx.save();
    ctx.globalAlpha = layerOpacityOf(layer);
    ctx.globalCompositeOperation = layerBlendModeOf(layer);
    ctx.translate(layer.x, layer.y);
    ctx.rotate((layer.rotation || 0) * Math.PI / 180);
    const suppliedReplacement = typeof replacements === 'string' ? replacements : replacements?.[layer.id];
    const boundReplacement = layer.type === 'slot' && layer.boundLayerId && typeof replacements !== 'string' ? replacements?.[layer.boundLayerId] : undefined;
    const replacement = layer.type === 'slot' && !layer.replacementDisabled && !layer.slotFill ? (suppliedReplacement || boundReplacement) : undefined;
    const replacementSources = layer.type === 'slot'
      ? (Array.isArray(replacement) ? replacement.filter(Boolean) : replacement ? [replacement] : [])
      : [];
    const src = layer.type === 'slot' ? (layer.slotFill ? '' : (replacementSources[0] || (layer.replacementDisabled ? '' : layer.src))) : layer.src;
    if (layer.eraseSrc) {
      const isolated = await renderIsolatedLayer(layer, layer.type === 'slot' ? replacement : src, photoTransforms[layer.id], null, null, scale);
      ctx.drawImage(isolated.canvas, -isolated.insets.left, -isolated.insets.top, isolated.logicalWidth, isolated.logicalHeight);
      ctx.restore();
      continue;
    }
    if (layer.type === 'text') {
      drawTextLayer(ctx, layer);
      await drawPaintOverlay(ctx, layer);
      await drawMosaicOverlay(ctx, layer);
      drawLayerBorder(ctx, layer);
      ctx.restore();
      continue;
    }
    const shapeClipped = layer.type === 'slot';
    if (shapeClipped) { ctx.save(); traceLayerShape(ctx, layer); ctx.clip(); }
    if (layer.type === 'slot' && replacementSources.length && multiPhotoLayoutOf(layer) !== 'none') {
      await drawMultiPhotoSources(ctx, layer, replacementSources, signal);
      await drawPaintOverlay(ctx, layer);
      await drawMosaicOverlay(ctx, layer);
    } else if (!src) {
      if (layer.slotFill) {
        ctx.fillStyle = layer.slotFill;
        traceLayerShape(ctx, layer); ctx.fill();
      } else if (!layer.replacementDisabled) {
        ctx.fillStyle = '#e8e6df';
        traceLayerShape(ctx, layer); ctx.fill();
        ctx.strokeStyle = '#9d9b94'; ctx.lineWidth = 3; ctx.setLineDash([10, 8]);
        traceLayerShape(ctx, layer); ctx.stroke();
        ctx.setLineDash([]);
      }
      await drawPaintOverlay(ctx, layer);
      await drawMosaicOverlay(ctx, layer);
    } else {
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
      await drawPaintOverlay(ctx, layer);
      await drawMosaicOverlay(ctx, layer);
    }
    if (shapeClipped) ctx.restore();
    drawLayerBorder(ctx, layer);
    ctx.restore();
  }
  if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
  return canvas.toDataURL(mime, mime === 'image/jpeg' ? .92 : undefined);
}


const isGifDataUrl = (source) => {
  if (typeof source !== 'string') return false;
  const match = source.match(/^data:image\/gif(?:;[^,]*)?;base64,([^,]*)$/i);
  if (!match) return false;
  try {
    return isGifBytes(Uint8Array.from(atob(match[1].slice(0, 12)), (character) => character.charCodeAt(0)));
  } catch {
    return false;
  }
};

const isGifSource = (source) => typeof source === 'string' && (
  isGifDataUrl(source)
  || (!/^data:/i.test(source) && /\.gif(?:[?#]|$)/i.test(source))
);

function sourceForLayer(template, layer, replacements = {}) {
  return layerSourceForRender(layer, replacements);
}

function animationFrameAtTime(animation, time) {
  const total = animation.frames.reduce((sum, frame) => sum + Math.max(20, Number(frame.delayMs) || 100), 0) || 100;
  let cursor = ((time % total) + total) % total;
  for (const frame of animation.frames) {
    const delay = Math.max(20, Number(frame.delayMs) || 100);
    if (cursor < delay) return frame;
    cursor -= delay;
  }
  return animation.frames.at(-1);
}

async function renderAnimatedTemplate(template, replacements = {}, photoTransforms = {}, options = {}) {
  const signal = typeof options === 'object' ? options.signal : null;
  if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
  const scale = typeof options === 'number' ? options : clamp(options.scale || 1, 1, 10);
  const transparent = typeof options === 'object' && Boolean(options.transparent);
  const animations = [];
  for (const layer of template.layers || []) {
    if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
    const source = sourceForLayer(template, layer, replacements);
    if (!isGifSource(source)) continue;
    const decoded = await desktop.decodeGifFrames(source);
    if (!decoded?.frames?.length) continue;
    const customDelays = Array.isArray(layer.gifFrameDelays) && layer.gifFrameDelays.length === decoded.frames.length ? layer.gifFrameDelays : null;
    const frames = customDelays ? decoded.frames.map((frame, index) => ({ ...frame, delayMs: Number(customDelays[index]) || frame.delayMs })) : decoded.frames;
    animations.push({ layer, source, ...decoded, frames });
  }
  if (!animations.length) {
    const png = await renderTemplate(template, replacements, photoTransforms, { scale, transparent, mime: 'image/png', signal });
    return desktop.encodeGifFrames([{ dataUrl: png, delayMs: 100 }], null);
  }
  const durationOf = (animation) => animation.frames.reduce((sum, frame) => sum + Math.max(20, Number(frame.delayMs) || 100), 0);
  const totalDuration = Math.max(...animations.map(durationOf), 100);
  const timePoints = new Set([0, totalDuration]);
  animations.forEach((animation) => {
    const duration = durationOf(animation);
    let elapsed = 0;
    while (elapsed < totalDuration && timePoints.size < 240) {
      timePoints.add(elapsed);
      const current = animationFrameAtTime(animation, elapsed % duration);
      elapsed += Math.max(20, Number(current?.delayMs) || 100);
    }
  });
  let points = [...timePoints].sort((a, b) => a - b);
  if (points.length > 121) {
    const stride = Math.ceil((points.length - 1) / 120);
    points = points.filter((_, index) => index === 0 || index === points.length - 1 || index % stride === 0);
    if (points.at(-1) !== totalDuration) points.push(totalDuration);
  }
  const outputFrames = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
    const start = points[index];
    const end = points[index + 1];
    const frameReplacements = { ...replacements };
    const animatedSources = new Map();
    animations.forEach((animation) => {
      const frame = animationFrameAtTime(animation, start);
      animatedSources.set(animation.layer.id, frame?.dataUrl);
      if (animation.layer.type === 'slot') frameReplacements[animation.layer.id] = frame?.dataUrl || '';
    });
    const frameTemplate = {
      ...template,
      layers: (template.layers || []).map((layer) => {
        const frameSource = animatedSources.get(layer.id);
        return frameSource && layer.type !== 'slot' ? { ...layer, src: frameSource } : layer;
      })
    };
    const dataUrl = await renderTemplate(frameTemplate, frameReplacements, photoTransforms, { scale, transparent, mime: 'image/png', frameIndex: index + 1 });
    outputFrames.push({ dataUrl, delayMs: Math.max(20, Math.round(end - start)) });
    options.onFrameProgress?.((index + 1) / Math.max(1, points.length - 1));
  }
  if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
  return desktop.encodeGifFrames(outputFrames, null);
}

async function renderAnimatedBatchTemplate(template, slotId, sources = [], replacements = {}, photoTransforms = {}, options = {}) {
  const usableSources = sources.filter(Boolean);
  if (!slotId || !usableSources.length) {
    return renderAnimatedTemplate(template, replacements, photoTransforms, options);
  }
  const outputFrames = [];
  for (let index = 0; index < usableSources.length; index += 1) {
    if (options.signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
    const source = usableSources[index];
    const dataUrl = await renderAnimatedTemplate(
      template,
      { ...replacements, [slotId]: source },
      { ...photoTransforms, [slotId]: photoTransforms[slotId] || { zoom: 1, offsetX: 0, offsetY: 0 } },
      options
    );
    if (options.signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
    const decoded = await desktop.decodeGifFrames(dataUrl);
    if (decoded?.frames?.length) outputFrames.push(...decoded.frames);
    options.onBatchProgress?.((index + 1) / usableSources.length);
  }
  if (!outputFrames.length) throw new Error('没有可导出的 GIF 帧');
  return desktop.encodeGifFrames(outputFrames, null);
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

const EMPTY_IMAGE_SOURCES = Object.freeze([]);

function useHtmlImages(sources = EMPTY_IMAGE_SOURCES) {
  const [images, setImages] = useState([]);
  useEffect(() => {
    const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
    if (!list.length) { setImages([]); return undefined; }
    let alive = true;
    Promise.all(list.map((src) => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = src;
    }))).then((loaded) => { if (alive) setImages(loaded.filter(Boolean)); });
    return () => { alive = false; };
  }, [sources]);
  return images;
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
  const zoomFrameRef = useRef(null);
  const pendingZoomRef = useRef(null);

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
    stopPanRef.current?.();
    const rect = event.currentTarget.getBoundingClientRect();
    const previous = pendingZoomRef.current;
    pendingZoomRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      rectLeft: rect.left,
      rectTop: rect.top,
      rectWidth: rect.width,
      rectHeight: rect.height,
      deltaY: (previous?.deltaY || 0) + event.deltaY
    };
    if (zoomFrameRef.current !== null) return;
    zoomFrameRef.current = requestAnimationFrame(() => {
      zoomFrameRef.current = null;
      const request = pendingZoomRef.current;
      pendingZoomRef.current = null;
      if (!request) return;
      const pointer = {
        x: request.clientX - request.rectLeft - request.rectWidth / 2,
        y: request.clientY - request.rectTop - request.rectHeight / 2
      };
      const current = zoomRef.current;
      const next = wheelZoom(current, request.deltaY, minZoom, maxZoom);
      if (next === current) return;
      const previousPan = panRef.current;
      setPan({
        x: pointer.x - (pointer.x - previousPan.x) * next / current,
        y: pointer.y - (pointer.y - previousPan.y) * next / current
      });
      zoomRef.current = next;
      setZoomState(next);
    });
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

  useEffect(() => () => { stopPanRef.current?.(); if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current); }, []);

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
  const [useSessions, setUseSessions] = useState({});
  const [config, setConfig] = useState({ theme: 'system', autoCopy: true, libraryCardSize: 'large' });
  const [templateFolders, setTemplateFolders] = useState([]);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState({ name: 'library' });
  const [toast, setToast] = useState(null);
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toastTimer = useRef();
  const editorDraftsRef = useRef({});
  const draftSaveQueue = useRef(Promise.resolve());
  const useSessionsRef = useRef({});
  const useSessionSaveQueue = useRef(Promise.resolve());

  useEffect(() => {
    const suppressBlankContextMenu = (event) => {
      if (!isTextEditingTarget(event.target)) event.preventDefault();
    };
    window.addEventListener('contextmenu', suppressBlankContextMenu);
    return () => window.removeEventListener('contextmenu', suppressBlankContextMenu);
  }, []);

  useEffect(() => { const suppressAltMenu = (event) => { if (event.key === 'Alt') event.preventDefault(); }; window.addEventListener('keydown', suppressAltMenu, true); window.addEventListener('keyup', suppressAltMenu, true); return () => { window.removeEventListener('keydown', suppressAltMenu, true); window.removeEventListener('keyup', suppressAltMenu, true); }; }, []);

  const notify = useCallback((message, kind = '') => {
    clearTimeout(toastTimer.current); setToast({ message, kind });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const updateConfig = useCallback(async (patch) => { const next = { ...config, ...patch }; setConfig(next); applyTheme(next.theme); try { await desktop.saveConfig(next); } catch (error) { notify(`设置保存失败：${error?.message || error}`, 'error'); } }, [config, notify]);

  useEffect(() => {
    Promise.all([desktop.loadTemplates(), desktop.listTemplateFolders(), desktop.loadConfig(), desktop.loadEditorDrafts(), desktop.loadUseSessions()]).then(([saved, loadedFolders, loadedConfig, savedDrafts, savedUseSessions]) => {
      const localTemplates = Array.isArray(saved) ? saved : [];
      const builtInTemplates = bundledTemplates.length ? structuredClone(bundledTemplates) : starterTemplates();
      const merged = localTemplates.length ? [...localTemplates, ...builtInTemplates] : builtInTemplates;
      const next = merged.filter((item, index) => merged.findIndex((candidate) => candidate.id === item.id) === index);
      const drafts = savedDrafts && typeof savedDrafts === 'object' && !Array.isArray(savedDrafts) ? savedDrafts : {};
      const sessions = savedUseSessions && typeof savedUseSessions === 'object' && !Array.isArray(savedUseSessions) ? savedUseSessions : {};
      applyTheme(loadedConfig?.theme);
      editorDraftsRef.current = drafts;
      useSessionsRef.current = sessions;
       setEditorDrafts(drafts); setUseSessions(sessions); setTemplates(next); setTemplateFolders(Array.isArray(loadedFolders) ? loadedFolders : []); setConfig((previous) => ({ ...previous, ...(loadedConfig || {}) })); setReady(true);
      if (next.length !== localTemplates.length) desktop.saveTemplates(next);
    }).catch((error) => {
      console.error(error);
       setTemplates(bundledTemplates.length ? structuredClone(bundledTemplates) : starterTemplates());
       setTemplateFolders([]);
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

  const persistUseSessions = useCallback((next) => {
    useSessionsRef.current = next;
    setUseSessions(next);
    useSessionSaveQueue.current = useSessionSaveQueue.current
      .catch(() => undefined)
      .then(() => desktop.saveUseSessions(next));
    return useSessionSaveQueue.current;
  }, []);

  const saveUseSession = useCallback((key, value) => persistUseSessions({ ...useSessionsRef.current, [key]: value }), [persistUseSessions]);
  const clearUseSession = useCallback((key) => {
    const next = { ...useSessionsRef.current };
    delete next[key];
    return persistUseSessions(next);
  }, [persistUseSessions]);

  const saveTemplate = async (template) => {
    const existing = templates.some((item) => item.id === template.id);
    const next = existing ? templates.map((item) => item.id === template.id ? template : item) : [template, ...templates];
    await commitTemplates(next); setPage({ name: 'library' }); notify('模板已保存');
  };

  const deleteTemplate = async (id) => {
    if (!confirm('确定删除这个模板吗？此操作不可撤销。')) return;
    await Promise.all([commitTemplates(templates.filter((item) => item.id !== id)), clearUseSession(id)]); notify('模板已删除');
  };
  const copyTemplate = async (template) => {
    const usedNames = new Set(templates.map((item) => item.name.trim().toLocaleLowerCase()));
    let name = `${template.name} 副本`; let suffix = 2;
    while (usedNames.has(name.toLocaleLowerCase())) name = `${template.name} 副本 ${suffix++}`;
    const layerIds = new Map((template.layers || []).map((layer) => [layer.id, uid()]));
    const groupIds = new Map(Object.keys(template.groupMeta || {}).map((groupId) => [groupId, uid()]));
    const copied = structuredClone(template);
    copied.id = uid(); copied.name = name; copied.createdAt = Date.now(); copied.updatedAt = Date.now(); copied.lastUsedAt = undefined; copied.favorite = false;
    copied.layers = (copied.layers || []).map((layer) => ({ ...layer, id: layerIds.get(layer.id) || uid(), groupId: layer.groupId ? groupIds.get(layer.groupId) : undefined, boundLayerId: layer.boundLayerId ? layerIds.get(layer.boundLayerId) : undefined }));
    copied.groupMeta = Object.fromEntries(Object.entries(copied.groupMeta || {}).map(([groupId, meta]) => [groupIds.get(groupId) || uid(), meta]));
    await commitTemplates([copied, ...templates]);
    notify('模板已复制');
  };

  const useTemplate = async (template, file) => {
    const nextTemplate = { ...template, lastUsedAt: Date.now() };
    const next = templates.map((item) => item.id === template.id ? nextTemplate : item);
    setTemplates(next);
    desktop.saveTemplates(next).catch(() => undefined);
    setPage({ name: 'use', template: nextTemplate, files: Array.isArray(file) ? file : file ? [file] : [] });
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

  const refreshTemplates = useCallback(async () => {
    try {
       const [saved, loadedFolders] = await Promise.all([desktop.loadTemplates(), desktop.listTemplateFolders()]);
      const localTemplates = Array.isArray(saved) ? saved : [];
      const builtInTemplates = bundledTemplates.length ? structuredClone(bundledTemplates) : starterTemplates();
      const merged = localTemplates.length ? [...localTemplates, ...builtInTemplates] : builtInTemplates;
      const next = merged.filter((item, index) => merged.findIndex((candidate) => candidate.id === item.id) === index);
      const previousIds = new Set(templates.map((item) => item.id));
      const addedCount = next.filter((item) => !previousIds.has(item.id)).length;
       setTemplates(next);
       setTemplateFolders(Array.isArray(loadedFolders) ? loadedFolders : []);
      notify(addedCount ? `模板库已刷新，发现 ${addedCount} 个新模板` : '模板库已刷新，未发现新模板');
    } catch (error) {
      notify(`刷新模板库失败：${error?.message || error}`, 'error');
      throw error;
    }
  }, [notify, templates]);

  if (!ready) return <div className="loading-screen"><Sparkles size={26}/><span>正在准备模板库...</span></div>;

  return <div className="app-shell">
     {page.name === 'library' && <Library templates={templates} folders={templateFolders} cardSize={config.libraryCardSize || 'large'} query={query} setQuery={setQuery} onCardSizeChange={(libraryCardSize) => updateConfig({ libraryCardSize })} onRefresh={refreshTemplates} onCreate={() => setPage({ name: 'editor' })} onOpenSettings={() => setSettingsOpen(true)} onEdit={(template) => setPage({ name: 'editor', template })} onRename={renameTemplate} onUse={useTemplate} onDelete={deleteTemplate} onCopy={copyTemplate} onToggleFavorite={toggleFavorite} notify={notify}/>}
    {page.name === 'editor' && <Editor initial={page.template} autosave={editorDrafts[page.template?.id || 'new']} onSaveDraft={saveEditorDraft} onClearDraft={clearEditorDraft} onBack={() => setPage({ name: 'library' })} onSave={saveTemplate} notify={notify}/>}
    {page.name === 'use' && <UseTemplate template={page.template} initialFiles={page.files} cachedSession={useSessions[page.template.id]} onSaveSession={saveUseSession} onBack={() => setPage({ name: 'library' })} onEdit={() => setPage({ name: 'editor', template: page.template })} notify={notify}/>}
    {settingsOpen && <SettingsDialog config={config} onChange={updateConfig} onClose={() => setSettingsOpen(false)}/>}
    <Toast toast={toast}/>
  </div>;
}

function Brand() {
  return <div className="brand"><div className="brand-mark"><Sparkles size={20}/></div><span>MemeHelper</span></div>;
}

function useExportProgress(notify) {
  const activeJobRef = useRef(null);
  const sequenceRef = useRef(0);
  const [progress, setProgress] = useState(null);

  const begin = useCallback((label = '导出中') => {
    if (activeJobRef.current) {
      activeJobRef.current.cancelled = true;
      activeJobRef.current.controller?.abort();
    }
    const job = { id: ++sequenceRef.current, cancelled: false, controller: new AbortController() };
    activeJobRef.current = job;
    setProgress({ id: job.id, label, value: 0 });
    return job;
  }, []);

  const update = useCallback((job, value, label) => {
    if (!job || job.cancelled || activeJobRef.current !== job) return false;
    setProgress((current) => current?.id === job.id
      ? { ...current, value: clamp(Number(value) || 0, 0, 100), ...(label ? { label } : {}) }
      : current);
    return true;
  }, []);

  const isCancelled = useCallback((job) => !job || job.cancelled || activeJobRef.current !== job, []);

  const finish = useCallback((job) => {
    if (activeJobRef.current !== job) return;
    activeJobRef.current = null;
    setProgress(null);
  }, []);

  const cancel = useCallback(() => {
    const job = activeJobRef.current;
    if (!job) return;
    job.cancelled = true;
    job.controller?.abort();
    activeJobRef.current = null;
    setProgress(null);
    notify?.('已取消导出');
  }, [notify]);

  useEffect(() => () => {
    if (activeJobRef.current) {
      activeJobRef.current.cancelled = true;
      activeJobRef.current.controller?.abort();
    }
    activeJobRef.current = null;
  }, []);

  return { progress, begin, update, isCancelled, finish, cancel };
}

function ExportProgressOverlay({ progress, onCancel }) {
  if (!progress) return null;
  const value = clamp(Math.round(progress.value || 0), 0, 100);
  return <div className="export-busy-overlay" role="status" aria-live="polite">
    <div className="export-progress-card">
      <div className="export-progress-heading"><RefreshCw size={21}/><span>{progress.label || '导出中'}</span><strong>{value}%</strong></div>
      <div className="export-progress-track" aria-label="导出进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={value} role="progressbar"><span style={{ width: `${value}%` }}/></div>
      <button type="button" className="export-cancel-button" onClick={onCancel}><X size={15}/>取消导出</button>
    </div>
  </div>;
}

function SettingsDialog({ config, onChange, onClose }) {
  const themeOptions = [{ value: 'light', label: '浅色', description: '使用明亮的浅色界面。', icon: Sun }, { value: 'dark', label: '深色', description: '使用深色界面，适合夜间使用。', icon: Monitor }, { value: 'system', label: '跟随 Windows 系统', description: '跟随系统的浅色或深色设置。', icon: Settings }];
  const sizeOptions = [{ value: 'small', label: '小' }, { value: 'medium', label: '中' }, { value: 'large', label: '大' }];
  return <div className="settings-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="settings-dialog" role="dialog" aria-modal="true"><div className="settings-dialog-heading"><div><p className="eyebrow">全局设置</p><h2>界面主题与主页显示</h2></div><IconButton label="关闭" onClick={onClose}><X size={18}/></IconButton></div><div className="settings-dialog-section"><h3>界面主题</h3><div className="settings-options">{themeOptions.map(({ value, label, description, icon: Icon }) => <button type="button" key={value} className={`settings-option ${config.theme === value ? 'active' : ''}`} onClick={() => onChange({ theme: value })}><span className="settings-option-icon"><Icon size={18}/></span><span><strong>{label}</strong><small>{description}</small></span><span className="settings-option-check">{config.theme === value ? '✓' : ''}</span></button>)}</div></div><div className="settings-dialog-section"><h3>主页模板显示大小</h3><div className="settings-size-options">{sizeOptions.map(({ value, label }) => <button type="button" key={value} className={`settings-size-option ${((config.libraryCardSize || 'large') === value) ? 'active' : ''}`} onClick={() => onChange({ libraryCardSize: value })}><span className="settings-size-radio">{(config.libraryCardSize || 'large') === value ? '●' : '○'}</span><strong>{label}</strong></button>)}</div></div><p className="settings-note">设置会立即生效，并保存到程序目录的 Data/config.json。</p></div></div>;
}

function Library({ templates, folders = [], cardSize = 'large', query, setQuery, onCardSizeChange, onRefresh, onCreate, onOpenSettings, onEdit, onRename, onUse, onDelete, onCopy, onToggleFavorite, notify }) {
  const [sort, setSort] = useState('recent');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [templateType, setTemplateType] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [currentFolder, setCurrentFolder] = useState('');
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await onRefresh(); }
    catch { /* The app-level toast reports the load error. */ }
    finally { setRefreshing(false); }
  };
  const normalizedFolder = String(currentFolder || '').replace(/\\/g, '/').replace(/^\/|\/$/g, '');
  const childFolders = folders
    .map((folder) => String(folder || '').replace(/\\/g, '/').replace(/^\/|\/$/g, ''))
    .filter((folder) => {
      const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
      return parent === normalizedFolder;
    })
    .filter((folder, index, list) => list.indexOf(folder) === index)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const folderName = (folder) => folder.split('/').at(-1) || 'meme';
  const parentFolder = normalizedFolder.includes('/') ? normalizedFolder.slice(0, normalizedFolder.lastIndexOf('/')) : '';
  const normalizedQuery = query.trim().toLowerCase();
  const visibleFolders = normalizedQuery
    ? folders
      .map((folder) => String(folder || '').replace(/\\/g, '/').replace(/^\/|\/$/g, ''))
      .filter((folder) => folder && (folderName(folder).toLowerCase().includes(normalizedQuery) || folder.toLowerCase().includes(normalizedQuery)))
      .filter((folder, index, list) => list.indexOf(folder) === index)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    : childFolders;
  const filtered = templates
    .filter((item) => normalizedQuery || String(item._folderPath || '').replace(/\\/g, '/').replace(/^\/|\/$/g, '') === normalizedFolder)
    .filter((item) => !favoritesOnly || item.favorite)
    .filter((item) => {
      const isGifTemplate = item.layers?.some((layer) => isGifSource(layer.src));
      if (templateType === 'gif') return Boolean(isGifTemplate);
      if (templateType === 'static') return !isGifTemplate;
      return true;
    })
    .filter((item) => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery) || (item.tags || []).some((tag) => tag.toLowerCase().includes(normalizedQuery)) || String(item._folderPath || '').toLowerCase().includes(normalizedQuery))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'created' ? (b.createdAt || 0) - (a.createdAt || 0) : (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0));
  const breadcrumbParts = normalizedFolder ? normalizedFolder.split('/') : [];
  const wheelSwitchAtRef = useRef(-Infinity);
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key !== 'Escape' || event.repeat || !normalizedFolder || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      event.preventDefault();
      setCurrentFolder(parentFolder);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [normalizedFolder, parentFolder]);
  useEffect(() => {
    const handleCardSizeWheel = (event) => {
      if (!event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      const now = performance.now();
      if (now - wheelSwitchAtRef.current < 180) return;
      wheelSwitchAtRef.current = now;
      const sizes = ['small', 'medium', 'large'];
      const currentIndex = Math.max(0, sizes.indexOf(cardSize));
      const nextIndex = clamp(currentIndex + (event.deltaY < 0 ? 1 : -1), 0, sizes.length - 1);
      if (nextIndex !== currentIndex) onCardSizeChange?.(sizes[nextIndex]);
    };
    window.addEventListener('wheel', handleCardSizeWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', handleCardSizeWheel, { capture: true });
  }, [cardSize, onCardSizeChange]);
  return <main className={`library-page library-size-${['small', 'medium', 'large'].includes(cardSize) ? cardSize : 'large'}`}>
    <header className="topbar"><Brand/><div className="topbar-actions"><button className="secondary-button" onClick={onOpenSettings}><Settings size={17}/>设置</button><span className="storage-note">{desktop.isDesktop ? '模板保存在程序目录的 meme 文件夹' : '模板保存在浏览器'}</span><button className="secondary-button" onClick={refresh} disabled={refreshing}><RefreshCw className={refreshing ? 'refresh-icon spinning' : 'refresh-icon'} size={17}/>{refreshing ? '刷新中' : '刷新'}</button><button className="primary-button" onClick={onCreate}><Plus size={18}/>新建模板</button></div></header>
    <section className="library-heading"><div><p className="eyebrow">模板工作台</p><h1>选择一个模板，马上开始</h1><p>点击使用，或把图片直接拖到模板上。</p><nav className="library-breadcrumb" aria-label="模板目录路径"><button type="button" onClick={() => setCurrentFolder('')}>meme</button>{breadcrumbParts.map((part, index) => { const target = breadcrumbParts.slice(0, index + 1).join('/'); return <React.Fragment key={target}><span>/</span><button type="button" onClick={() => setCurrentFolder(target)}>{part}</button></React.Fragment>; })}<span>/</span></nav></div><div className="library-controls"><div className="search-box"><LayoutTemplate size={18}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称或标签"/></div><button className={`favorite-filter ${favoritesOnly ? 'active' : ''}`} onClick={() => setFavoritesOnly((current) => !current)}><Star size={16} fill={favoritesOnly ? 'currentColor' : 'none'}/>收藏</button><div className="template-type-filter" role="group" aria-label="模板类型"><button className={templateType === 'all' ? 'active' : ''} onClick={() => setTemplateType('all')}>全部</button><button className={templateType === 'gif' ? 'active' : ''} onClick={() => setTemplateType('gif')}>GIF</button><button className={templateType === 'static' ? 'active' : ''} onClick={() => setTemplateType('static')}>普通</button></div><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="模板排序"><option value="recent">最近使用</option><option value="created">最近创建</option><option value="name">按名称</option></select></div></section>
    <section className="template-grid">
      {normalizedFolder && <button className="folder-card folder-parent-card" onClick={() => setCurrentFolder(parentFolder)}><span className="folder-card-icon"><ArrowLeft size={24}/></span><strong>返回上一级</strong><small>{parentFolder ? `${folderName(parentFolder)}/` : 'meme/'}</small></button>}
      {visibleFolders.map((folder) => <button className="folder-card" key={folder} onClick={() => { setCurrentFolder(folder); if (normalizedQuery) setQuery(''); }}><span className="folder-card-icon"><FolderOpen size={24}/></span><strong>{folderName(folder)}</strong><small>{`${folder}/`}</small></button>)}
      {filtered.map((template) => <TemplateCard key={template.id} template={template} onUse={onUse} onEdit={onEdit} onRename={onRename} onCopy={onCopy} onDelete={onDelete} onToggleFavorite={onToggleFavorite} notify={notify}/>) }
      <button className="new-template-card" onClick={onCreate}><span className="new-icon"><Plus size={26}/></span><strong>创建新模板</strong><small>设置底图与照片位置</small></button>
    </section>
    {!filtered.length && !visibleFolders.length && <div className="empty-state"><LayoutTemplate size={34}/><h3>没有找到模板或文件夹</h3><p>换个关键词，或新建一个模板。</p></div>}
    <footer className="app-footer"><span>{filtered.length} 个模板</span></footer>
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

function TemplateCard({ template, onUse, onEdit, onRename, onCopy, onDelete, onToggleFavorite, notify }) {
  const [preview, setPreview] = useState('');
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [pasteMenu, setPasteMenu] = useState(null);
  const hasGif = template.layers.some((layer) => isGifSource(layer.src));
  const {
    progress: quickExportProgress,
    begin: beginQuickExport,
    update: updateQuickExport,
    isCancelled: isQuickExportCancelled,
    finish: finishQuickExport,
    cancel: cancelQuickExport
  } = useExportProgress(notify);
  const quickWorking = Boolean(quickExportProgress);
  const menuRef = useRef();
  const pasteMenuRef = useRef();
  const slots = useMemo(() => template.layers.filter(isReplaceableSlot), [template.layers]);
  const canQuickReplace = slots.length === 1;
  const slotCountHint = slots.length === 0
    ? '此模板没有可替换图层。'
    : slots.length === 1
      ? '1 个可替换图层：拖入或右键粘贴图片，即可生成并复制。'
      : `有 ${slots.length} 个可替换图层：进入模板后可分别替换图片。`;
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
  const renderQuickOutput = useCallback((source, exportOptions = {}) => {
    const replacements = { [slots[0].id]: source };
    return hasGif
      ? renderAnimatedTemplate(template, replacements, {}, { scale: 1, mime: 'image/gif', ...exportOptions })
      : renderTemplate(template, replacements, {}, exportOptions);
  }, [hasGif, slots, template]);
  const quickReplace = useCallback(async (source) => {
    if (!canQuickReplace || quickWorking) return;
    const job = beginQuickExport('正在生成作品');
    updateQuickExport(job, 8);
    try {
      const dataUrl = await renderQuickOutput(source, {
        signal: job.controller.signal,
        onFrameProgress: (value) => updateQuickExport(job, 8 + value * 68, `正在生成 GIF（${Math.round(value * 100)}%）`)
      });
      if (isQuickExportCancelled(job)) return;
      updateQuickExport(job, 78, '正在复制到剪贴板');
      await desktop.copyImage(dataUrl);
      if (isQuickExportCancelled(job)) return;
      updateQuickExport(job, 100, '导出完成');
      notify('作品已生成并复制到剪贴板');
    } catch (error) {
      if (!isQuickExportCancelled(job)) notify(`生成或复制失败：${error?.message || error}`, 'error');
    } finally {
      finishQuickExport(job);
    }
  }, [beginQuickExport, canQuickReplace, finishQuickExport, isQuickExportCancelled, notify, quickWorking, renderQuickOutput, updateQuickExport]);
  const quickReplaceBatch = useCallback(async (sources) => {
    if (!canQuickReplace || quickWorking || !sources.length) return;
    const job = beginQuickExport(hasGif ? '正在合成 GIF' : '正在批量生成作品');
    updateQuickExport(job, 5);
    try {
      if (hasGif) {
        const output = await renderAnimatedBatchTemplate(template, slots[0].id, sources, {}, {}, {
          scale: 1,
          mime: 'image/gif',
          signal: job.controller.signal,
          onBatchProgress: (value) => updateQuickExport(job, 5 + value * 76, `正在合成 GIF（${Math.round(value * 100)}%）`)
        });
        if (isQuickExportCancelled(job)) return;
        updateQuickExport(job, 86, '正在复制 GIF 到剪贴板');
        await desktop.copyImage(output);
        if (isQuickExportCancelled(job)) return;
        updateQuickExport(job, 100, '导出完成');
        notify(`已将 ${sources.length} 张图片合成为 1 个 GIF 并复制`);
      } else {
        const outputs = [];
        for (let index = 0; index < sources.length; index += 1) {
          if (isQuickExportCancelled(job)) return;
          outputs.push(await renderQuickOutput(sources[index], { signal: job.controller.signal }));
          if (isQuickExportCancelled(job)) return;
          updateQuickExport(job, 5 + (index + 1) / sources.length * 73, `正在生成第 ${index + 1}/${sources.length} 张作品`);
        }
        if (isQuickExportCancelled(job)) return;
        updateQuickExport(job, 86, '正在复制到剪贴板');
        if (outputs.length === 1) await desktop.copyImage(outputs[0]);
        else await desktop.copyImages(outputs);
        if (isQuickExportCancelled(job)) return;
        updateQuickExport(job, 100, '导出完成');
        notify(`已生成并复制 ${outputs.length} 张作品`);
      }
    } catch (error) {
      if (!isQuickExportCancelled(job)) notify(`批量生成或复制失败：${error?.message || error}`, 'error');
    } finally {
      finishQuickExport(job);
    }
  }, [beginQuickExport, canQuickReplace, finishQuickExport, hasGif, isQuickExportCancelled, notify, quickWorking, renderQuickOutput, slots, template, updateQuickExport]);
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
    const files = Array.from(event.dataTransfer.files || []).filter((file) => isImageFileLike(file));
    if (!files.length) return notify('请拖入图片文件', 'error');
    if (canQuickReplace) {
      try {
        const sources = await Promise.all(files.map((file) => fileToDataUrl(file)));
        if (sources.length > 1) await quickReplaceBatch(sources);
        else await quickReplace(sources[0]);
      } catch (error) { notify(`读取图片失败：${error?.message || error}`, 'error'); }
      return;
    }
    // Templates with multiple replacement slots are opened in the use page;
    // pass every dropped image so the page can fill slots in sidebar order.
    onUse(template, files.length > 1 ? files : files[0]);
  };
  const openPasteMenu = (event) => {
    if (!canQuickReplace) return;
    event.preventDefault();
    event.stopPropagation();
    setMenu(false);
    setPasteMenu({ x: Math.min(event.clientX, window.innerWidth - 196), y: Math.min(event.clientY, window.innerHeight - 52) });
  };
  const openTemplateFolder = async () => {
    setMenu(false);
    try {
      const opened = await desktop.openTemplateFolder(template.id);
      if (!opened) notify('浏览器模式无法打开模板文件夹', 'error');
    } catch (error) {
      notify(`打开模板文件夹失败：${error?.message || error}`, 'error');
    }
  };
  return <><article className={`template-card ${dragging ? 'dragging' : ''} ${menu ? 'menu-open' : ''}`} onContextMenu={openPasteMenu} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
    <div className="template-preview" onClick={() => onUse(template)}>{hasGif && <span className="template-gif-badge">GIF</span>}<span className="slot-count-badge" title={slotCountHint} aria-label={slotCountHint}>{slots.length}</span>{preview && <img src={preview} alt="" draggable={false}/>}<div className="drop-hint"><Upload size={28}/><strong>{canQuickReplace ? '松开并复制作品' : '松开即可生成'}</strong></div></div>
    <div className="template-meta"><div><h3 title="双击编辑名称" onDoubleClick={(event) => { event.stopPropagation(); setRenaming(true); }}>{template.name}</h3><span>{template.width} x {template.height}</span>{Boolean(template.tags?.length) && <span className="template-tags">{template.tags.slice(0, 3).map((tag) => <small key={tag}>{tag}</small>)}</span>}</div><div className="template-card-tools"><IconButton label={template.favorite ? '取消收藏' : '收藏模板'} className={template.favorite ? 'favorite-active' : ''} onClick={() => onToggleFavorite(template.id)}><Star size={17} fill={template.favorite ? 'currentColor' : 'none'}/></IconButton><div ref={menuRef} className="card-menu-wrap"><IconButton label="模板操作" onClick={() => setMenu((current) => !current)}><MoreHorizontal size={19}/></IconButton>{menu && <div className="context-menu"><button onClick={() => { setMenu(false); setRenaming(true); }}><Type size={16}/>编辑名称</button><button onClick={() => { setMenu(false); onCopy?.(template); }}><Copy size={16}/>复制模板</button><button onClick={openTemplateFolder}><FolderOpen size={16}/>打开模板文件夹</button><button className="danger" onClick={() => { setMenu(false); onDelete(template.id); }}><Trash2 size={16}/>删除模板</button></div>}</div></div></div>
    <div className="card-actions"><button className="secondary-button" onClick={() => onEdit(template)}><Pencil size={16}/>编辑</button><button className="primary-button grow" onClick={() => onUse(template)}><Sparkles size={17}/>使用模板</button></div>
  </article>{pasteMenu && <div ref={pasteMenuRef} className="library-paste-menu" style={{ left: pasteMenu.x, top: pasteMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button onClick={pasteImage} disabled={quickWorking}><Clipboard size={16}/>粘贴图片并复制作品</button></div>}{renaming && <RenameTemplateDialog template={template} onCancel={() => setRenaming(false)} onSave={onRename}/>}<ExportProgressOverlay progress={quickExportProgress} onCancel={cancelQuickExport}/></>;
}

function GifTimeline({ frames = [], frameIndex, selectedIndexes = [], playing, layerInsertionIndex = null, onTogglePlay, onSelectFrame, onDropFrame, onDuplicateFrame, onDeleteFrame, onReorderFrame }) {
  const [frameMenu, setFrameMenu] = useState(null);
  const [dragState, setDragState] = useState(null);
  const [dropState, setDropState] = useState(null);
  const menuRef = useRef(null);
  const selectedSet = new Set(selectedIndexes);
  const menuSelectionCount = frameMenu && selectedSet.has(frameMenu.index) ? Math.max(1, selectedIndexes.length) : 1;
  useEffect(() => {
    if (!frameMenu) return undefined;
    const close = (event) => { if (!menuRef.current?.contains(event.target)) setFrameMenu(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [frameMenu]);
  const isFrameDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('application/x-meme-gif-frame');
  const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  const resolveInsertion = (event) => {
    const strip = event.currentTarget;
    const cells = [...strip.querySelectorAll('.gif-frame-cell')];
    if (!cells.length) return { targetIndex: 0, placement: 'before' };
    const pointerX = event.clientX;
    for (let index = 0; index < cells.length; index += 1) {
      const rect = cells[index].getBoundingClientRect();
      if (pointerX < rect.left + rect.width / 2) return { targetIndex: index, placement: 'before' };
    }
    return { targetIndex: cells.length, placement: 'before' };
  };
  const handleDrop = async (event, targetIndex = null, placement = 'before') => {
    event.preventDefault();
    event.stopPropagation();
    const sourceValue = event.dataTransfer?.getData('application/x-meme-gif-frame');
    if (sourceValue !== undefined && sourceValue !== '') {
      const sourceIndex = Number(sourceValue);
      const resolved = targetIndex == null ? resolveInsertion(event) : { targetIndex, placement };
      const insertionIndex = resolved.targetIndex + (resolved.placement === 'after' ? 1 : 0);
      onReorderFrame?.(sourceIndex, insertionIndex);
      setDragState(null); setDropState(null);
      return;
    }
    const files = Array.from(event.dataTransfer?.files || []).filter((file) => isImageFileLike(file));
    const file = files[0];
    if (!file) return;
    const resolved = targetIndex == null ? resolveInsertion(event) : { targetIndex, placement };
    const index = resolved.targetIndex + (resolved.placement === 'after' ? 1 : 0);
    onDropFrame(await fileToDataUrl(file), index);
    setDropState(null);
  };
  const scrollFrames = (event) => {
    if (!event.deltaX && !event.deltaY) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.scrollLeft += Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  };
  return <div className="gif-timeline">
    <div className="gif-timeline-heading"><div><strong>GIF 时间轴</strong><small>{frames.length ? `${frames.length} 帧` : '正在读取帧'}</small></div><button type="button" className="gif-play-button" disabled={!frames.length} onClick={onTogglePlay}>{playing ? '暂停' : '播放'}</button></div>
    <div className="gif-frame-strip" onWheel={scrollFrames} onDragOver={(event) => { if (isFrameDrag(event) || isFileDrag(event)) { event.preventDefault(); event.stopPropagation(); const resolved = resolveInsertion(event); setDropState(resolved); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropState(null); }} onDrop={(event) => handleDrop(event, dropState?.targetIndex ?? null, dropState?.placement || 'before')}>
      {frames.length ? frames.map((frame, index) => {
        const placement = layerInsertionIndex === index ? 'before' : dropState?.targetIndex === index ? dropState.placement : null;
        return <button type="button" draggable key={`${index}-${frame.dataUrl.slice(-12)}`} className={`gif-frame-cell ${selectedSet.has(index) ? 'selected' : ''} ${index === frameIndex ? 'active' : ''} ${dragState?.sourceIndex === index ? 'dragging' : ''} ${placement ? `drop-${placement}` : ''}`} onClick={(event) => { if (event.shiftKey) event.preventDefault(); onSelectFrame(index, event); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (!selectedSet.has(index)) onSelectFrame(index, {}); setFrameMenu({ index, x: Math.min(event.clientX, window.innerWidth - 160), y: Math.min(event.clientY, window.innerHeight - 84) }); }} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'copyMove'; event.dataTransfer.setData('application/x-meme-gif-frame', String(index)); setDragState({ sourceIndex: index }); setFrameMenu(null); }} onDragOver={(event) => { if (!isFrameDrag(event) && !isFileDrag(event)) return; event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); const nextPlacement = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'; setDropState({ targetIndex: index, placement: nextPlacement }); }} onDrop={(event) => { const rect = event.currentTarget.getBoundingClientRect(); const placement = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'; handleDrop(event, index, placement); }} onDragEnd={() => { setDragState(null); setDropState(null); }} title={`第 ${index + 1} 帧，${Math.max(20, Number(frame.delayMs) || 100)} ms`}><img src={frame.dataUrl} alt={`第 ${index + 1} 帧`} draggable={false}/><span>{index + 1}</span></button>;
      }) : <div className="gif-timeline-empty">GIF 帧加载中…</div>}
      {((dropState?.targetIndex === frames.length && dragState) || layerInsertionIndex === frames.length) && <span className="gif-frame-end-drop" aria-hidden="true"/>}
    </div>
    {frameMenu && <div ref={menuRef} className="gif-frame-context-menu" style={{ left: frameMenu.x, top: frameMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button type="button" onClick={() => { const index = frameMenu.index; setFrameMenu(null); onDuplicateFrame?.(index); }}><Copy size={15}/>{menuSelectionCount > 1 ? `复制 ${menuSelectionCount} 帧` : '复制帧'}</button><button type="button" className="danger" onClick={() => { const index = frameMenu.index; setFrameMenu(null); onDeleteFrame?.(index); }}><Trash2 size={15}/>{menuSelectionCount > 1 ? `删除 ${menuSelectionCount} 帧` : '删除帧'}</button></div>}
  </div>;
}function Editor({ initial, autosave, onSaveDraft, onClearDraft, onBack, onSave, notify }) {
  const draftKey = initial?.id || 'new';
  const initialStateRef = useRef();
  if (!initialStateRef.current) {
    const canRestore = autosave?.draft?.layers && (initial ? autosave.draft.id === initial.id && autosave.savedAt > (initial.updatedAt || 0) : autosave.kind === 'new');
    initialStateRef.current = {
      restored: Boolean(canRestore),
      draft: canRestore ? structuredClone(autosave.draft) : initial ? structuredClone(initial) : { id: uid(), name: '未命名模板', width: 0, height: 0, createdAt: Date.now(), updatedAt: Date.now(), layers: [] }
    };
  }
  const [draft, commitDraft, undo, canUndo, redo, canRedo] = useUndoState(() => initialStateRef.current.draft);
  const [selectedIds, setSelectedIds] = useState(() => draft.layers.at(-1)?.id ? [draft.layers.at(-1).id] : []);
  const selectedId = selectedIds.at(-1) || null;
  const { zoom, pan, panning, setZoom, zoomAtPointer, beginPan } = useCanvasViewport(.72, .2, 10);
  const [activeTool, setActiveTool] = useState('select');
  const [sizeMode, setSizeMode] = useState('canvas');
  const [imageSizeLocked, setImageSizeLocked] = useState(true);
  const [textOrientation, setTextOrientation] = useState('horizontal');
  const [textMenu, setTextMenu] = useState(false);
  const [paintColor, setPaintColor] = useState('#202124');
  const [brushSize, setBrushSize] = useState(18);
  const [eraserMode, setEraserMode] = useState('paint');
  const [eraserMenu, setEraserMenu] = useState(false);
  const [toolPointer, setToolPointer] = useState(null);
  const [outsideDragPreview, setOutsideDragPreview] = useState(null);
  const [textEditingId, setTextEditingId] = useState(null);
  const [textSelection, setTextSelection] = useState(null);
  const [propertyTextSelection, setPropertyTextSelection] = useState(null);
  const [dirty, setDirty] = useState(initialStateRef.current.restored);
  const [autosaveState, setAutosaveState] = useState(initialStateRef.current.restored ? 'saved' : 'idle');
  const [leavePrompt, setLeavePrompt] = useState(null);
  const lastPointerRef = useRef({ x: 420, y: 120 });
  const [shapeMenu, setShapeMenu] = useState(false);
  const [layerMenu, setLayerMenu] = useState(null);
  const [marqueeStartRequest, setMarqueeStartRequest] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set(
    Object.entries(draft.groupMeta || {})
      .filter(([, meta]) => meta?.collapsed)
      .map(([groupId]) => groupId)
  ));
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  // Keep the group selection separate from the active group used by the
  // properties panel/canvas.  A group is represented by all of its member
  // layer ids in selectedIds, while selectedGroupIds lets the layer list
  // preserve Ctrl/Shift multi-selection of group headers.
  const [selectedGroupIds, setSelectedGroupIds] = useState([]);
  const [draggedLayerId, setDraggedLayerId] = useState(null);
  const [layerDrop, setLayerDrop] = useState(null);
  const [gifFrameLayerDrop, setGifFrameLayerDrop] = useState(null);
  const [timelineLayerInsertionIndex, setTimelineLayerInsertionIndex] = useState(null);
  const [editingLayerName, setEditingLayerName] = useState(null);
  const [hasCopiedLayers, setHasCopiedLayers] = useState(false);
  const [tagsText, setTagsText] = useState(() => (initialStateRef.current.draft.tags || []).join(', '));
  const memeInput = useRef();
  const gifLayerInput = useRef();
  const [fixedLayerMenu, setFixedLayerMenu] = useState(false);
  const stageHostRef = useRef();
  const outsideDragRef = useRef(null);
  const clipboardLayersRef = useRef({ layers: [], groupMeta: {} });
  const layerReorderRef = useRef(null);
  const selectionAnchorRef = useRef(selectedIds.at(-1) || null);
  const groupSelectionAnchorRef = useRef(null);
  const [gifTimeline, setGifTimeline] = useState({ layerId: null, frames: [], frameIndex: 0, selectedIndexes: [], playing: false });
  const gifFrameAnchorRef = useRef(null);
  const selected = draft.layers.find((item) => item.id === selectedId);
  const selectedGifLayer = selected && isGifSource(selected.src) ? selected : null;
  const timelineGifLayer = selectedGifLayer
    || draft.layers.find((layer) => layer.id === gifTimeline.layerId && isGifSource(layer.src))
    || draft.layers.find((layer) => isGifSource(layer.src))
    || null;
  useEffect(() => {
    if (!leavePrompt) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (!event.target.closest?.('.leave-editor-prompt')) setLeavePrompt(null);
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => window.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [leavePrompt]);
  useEffect(() => {
    if (!timelineGifLayer) {
      setGifTimeline((current) => current.layerId ? { layerId: null, frames: [], frameIndex: 0, selectedIndexes: [], playing: false } : current);
      gifFrameAnchorRef.current = null;
      return undefined;
    }
    let alive = true;
    desktop.decodeGifFrames(timelineGifLayer.src).then((decoded) => {
      if (!alive) return;
      const customDelays = Array.isArray(timelineGifLayer.gifFrameDelays) && timelineGifLayer.gifFrameDelays.length === decoded.frames.length ? timelineGifLayer.gifFrameDelays : null;
      const frames = customDelays ? decoded.frames.map((frame, index) => ({ ...frame, delayMs: Number(customDelays[index]) || frame.delayMs })) : decoded.frames;
      setGifTimeline((current) => {
        const sameLayer = current.layerId === timelineGifLayer.id;
        const frameIndex = Math.min(sameLayer ? current.frameIndex : 0, Math.max(0, frames.length - 1));
        const selectedIndexes = sameLayer
          ? current.selectedIndexes.filter((index) => index >= 0 && index < frames.length)
          : frames.length ? [frameIndex] : [];
        return { layerId: timelineGifLayer.id, frames, frameIndex, selectedIndexes: selectedIndexes.length ? selectedIndexes : frames.length ? [frameIndex] : [], playing: sameLayer ? current.playing : false };
      });
      if (timelineGifLayer.gifFrameCount !== frames.length) updateLayer(timelineGifLayer.id, { gifFrameCount: frames.length });
    }).catch(() => { if (alive) setGifTimeline({ layerId: timelineGifLayer.id, frames: [], frameIndex: 0, selectedIndexes: [], playing: false }); });
    return () => { alive = false; };
  }, [timelineGifLayer?.id, timelineGifLayer?.src, timelineGifLayer?.gifFrameDelays]);

  useEffect(() => {
    if (!gifTimeline.playing || gifTimeline.layerId !== timelineGifLayer?.id || !gifTimeline.frames.length) return undefined;
    const delay = Math.max(20, Number(gifTimeline.frames[gifTimeline.frameIndex]?.delayMs) || 100);
    const timer = setTimeout(() => setGifTimeline((current) => ({ ...current, frameIndex: (current.frameIndex + 1) % current.frames.length })), delay);
    return () => clearTimeout(timer);
  }, [gifTimeline, timelineGifLayer?.id]);

  const selectGifFrame = (index, event = {}) => {
    const extend = Boolean(event.shiftKey);
    const toggle = Boolean(event.ctrlKey || event.metaKey);
    setGifTimeline((current) => {
      const safeIndex = Math.max(0, Math.min(current.frames.length - 1, index));
      let selectedIndexes;
      if (extend) {
        const anchor = gifFrameAnchorRef.current ?? current.frameIndex ?? safeIndex;
        const start = Math.min(anchor, safeIndex); const end = Math.max(anchor, safeIndex);
        selectedIndexes = Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
      } else if (toggle) {
        selectedIndexes = current.selectedIndexes.includes(safeIndex)
          ? current.selectedIndexes.filter((item) => item !== safeIndex)
          : [...current.selectedIndexes, safeIndex].sort((a, b) => a - b);
        gifFrameAnchorRef.current = safeIndex;
      } else {
        selectedIndexes = [safeIndex];
        gifFrameAnchorRef.current = safeIndex;
      }
      return { ...current, frameIndex: safeIndex, selectedIndexes, playing: false };
    });
    if (timelineGifLayer) {
      setSelectedIds([timelineGifLayer.id]);
      setSelectedGroupId(null);
      setSelectedGroupIds([]);
      selectionAnchorRef.current = timelineGifLayer.id;
    }
  };

  const updateGifFrameDelay = (index, delayMs, applyToAll = false) => {
    if (!timelineGifLayer || !gifTimeline.frames.length) return;
    const normalizedDelay = Math.max(20, Number(delayMs) || 100);
    const selectedIndexes = applyToAll
      ? gifTimeline.frames.map((_, frameIndex) => frameIndex)
      : gifTimeline.selectedIndexes.length ? gifTimeline.selectedIndexes : [index];
    const selectedSet = new Set(selectedIndexes);
    const delays = gifTimeline.frames.map((frame, frameIndex) => selectedSet.has(frameIndex) ? normalizedDelay : Math.max(20, Number(frame.delayMs) || 100));
    updateLayer(timelineGifLayer.id, { gifFrameDelays: delays });
    setGifTimeline((current) => ({ ...current, frames: current.frames.map((frame, frameIndex) => selectedSet.has(frameIndex) ? { ...frame, delayMs: delays[frameIndex] } : frame) }));
  };

  const commitGifFrames = async (nextFrames, nextFrameIndex, nextSelectedIndexes = [nextFrameIndex]) => {
    if (!timelineGifLayer || !nextFrames.length) return false;
    try {
      const encoded = await desktop.encodeGifFrames(nextFrames, null);
      const safeFrameIndex = Math.max(0, Math.min(nextFrames.length - 1, nextFrameIndex));
      const safeSelection = [...new Set(nextSelectedIndexes)].filter((index) => index >= 0 && index < nextFrames.length);
      updateLayer(timelineGifLayer.id, { src: encoded, gifFrameDelays: nextFrames.map((frame) => Math.max(20, Number(frame.delayMs) || 100)), gifFrameCount: nextFrames.length });
      gifFrameAnchorRef.current = safeFrameIndex;
      setGifTimeline({ layerId: timelineGifLayer.id, frames: nextFrames, frameIndex: safeFrameIndex, selectedIndexes: safeSelection.length ? safeSelection : [safeFrameIndex], playing: false });
      return true;
    } catch (error) { notify(`更新 GIF 帧失败：${error?.message || error}`, 'error'); return false; }
  };

  const insertGifFrames = async (incomingFrames, index = gifTimeline.frameIndex + 1) => {
    if (!timelineGifLayer || !incomingFrames?.length || !gifTimeline.frames.length) return false;
    const safeIndex = Math.round(clamp(index, 0, gifTimeline.frames.length));
    const width = gifTimeline.frames[0].width; const height = gifTimeline.frames[0].height;
    const normalizedFrames = [];
    for (const incomingFrame of incomingFrames) {
      const dataUrl = typeof incomingFrame === 'string' ? incomingFrame : incomingFrame?.dataUrl;
      if (!dataUrl) continue;
      const image = await loadImage(dataUrl);
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const crop = getCoverCrop(image, width, height);
      canvas.getContext('2d').drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
      normalizedFrames.push({ dataUrl: canvas.toDataURL('image/png'), delayMs: Math.max(20, Number(incomingFrame?.delayMs) || 100), width, height });
    }
    if (!normalizedFrames.length) return false;
    const nextFrames = [...gifTimeline.frames.slice(0, safeIndex), ...normalizedFrames, ...gifTimeline.frames.slice(safeIndex)];
    const insertedIndexes = normalizedFrames.map((_, offset) => safeIndex + offset);
    return commitGifFrames(nextFrames, safeIndex, insertedIndexes);
  };

  const insertGifFrame = async (dataUrl, index = gifTimeline.frameIndex + 1) => insertGifFrames([{ dataUrl, delayMs: 100 }], index);

  const insertLayerIntoGifTimeline = async (layerId, index) => {
    const layer = draft.layers.find((item) => item.id === layerId);
    if (!timelineGifLayer || !layer || !gifTimeline.frames.length) return;
    try {
      if (isGifSource(layer.src)) {
        const decoded = await desktop.decodeGifFrames(layer.src);
        if (!decoded?.frames?.length) throw new Error('GIF 图层没有可读取的帧');
        const customDelays = Array.isArray(layer.gifFrameDelays) && layer.gifFrameDelays.length === decoded.frames.length ? layer.gifFrameDelays : null;
        const renderedFrames = [];
        for (let frameIndex = 0; frameIndex < decoded.frames.length; frameIndex += 1) {
          const frame = decoded.frames[frameIndex];
          const frameLayer = { ...layer, src: frame.dataUrl, rotation: 0 };
          const isolated = await renderIsolatedLayer(frameLayer, frame.dataUrl, null, null, null);
          renderedFrames.push({ dataUrl: isolated.canvas.toDataURL('image/png'), delayMs: Math.max(20, Number(customDelays?.[frameIndex]) || Number(frame.delayMs) || 100) });
        }
        if (await insertGifFrames(renderedFrames, index)) notify(`已将“${layer.name}”的 ${renderedFrames.length} 帧插入时间轴`);
        return;
      }
      const isolated = await renderIsolatedLayer({ ...layer, rotation: 0 }, layer.src, null, null, null);
      if (await insertGifFrames([{ dataUrl: isolated.canvas.toDataURL('image/png'), delayMs: 100 }], index)) notify(`已将“${layer.name}”作为帧插入时间轴`);
    } catch (error) {
      notify(`图层插入时间轴失败：${error?.message || error}`, 'error');
    }
  };

  const duplicateGifFrame = async (index) => {
    if (!timelineGifLayer || !gifTimeline.frames[index]) return;
    const indexes = (gifTimeline.selectedIndexes.includes(index) ? gifTimeline.selectedIndexes : [index]).slice().sort((a, b) => a - b);
    const copies = indexes.map((frameIndex) => ({ ...gifTimeline.frames[frameIndex] }));
    const insertAt = Math.max(...indexes) + 1;
    const nextFrames = [...gifTimeline.frames.slice(0, insertAt), ...copies, ...gifTimeline.frames.slice(insertAt)];
    const selectedCopies = copies.map((_, offset) => insertAt + offset);
    if (await commitGifFrames(nextFrames, insertAt, selectedCopies)) notify(copies.length > 1 ? `已复制 ${copies.length} 帧` : 'GIF 帧已复制');
  };

  const deleteGifFrame = async (index) => {
    if (!timelineGifLayer || !gifTimeline.frames[index]) return;
    const indexes = (gifTimeline.selectedIndexes.includes(index) ? gifTimeline.selectedIndexes : [index]).slice().sort((a, b) => a - b);
    if (gifTimeline.frames.length - indexes.length < 1) return notify('GIF 至少需要保留一帧', 'error');
    const deleting = new Set(indexes);
    const nextFrames = gifTimeline.frames.filter((_, frameIndex) => !deleting.has(frameIndex));
    const nextIndex = Math.min(indexes[0], nextFrames.length - 1);
    if (await commitGifFrames(nextFrames, nextIndex, [nextIndex])) notify(indexes.length > 1 ? `已删除 ${indexes.length} 帧` : 'GIF 帧已删除');
  };

  const reorderGifFrame = async (sourceIndex, insertionIndex) => {
    if (!timelineGifLayer || sourceIndex < 0 || sourceIndex >= gifTimeline.frames.length) return;
    const nextFrames = [...gifTimeline.frames];
    const [moving] = nextFrames.splice(sourceIndex, 1);
    let insertAt = Math.max(0, Math.min(gifTimeline.frames.length, insertionIndex));
    if (sourceIndex < insertAt) insertAt -= 1;
    insertAt = Math.max(0, Math.min(nextFrames.length, insertAt));
    if (insertAt === sourceIndex) return;
    nextFrames.splice(insertAt, 0, moving);
    await commitGifFrames(nextFrames, insertAt, [insertAt]);
  };  const activeTextSelection = selected?.type === 'text'
    ? textEditingId === selected.id && textSelection?.id === selected.id
      ? textSelection
      : propertyTextSelection?.id === selected.id ? propertyTextSelection : null
    : null;
  const templateHasGif = draft.layers.some((layer) => isGifSource(layer.src));
  const selectedLayers = draft.layers.filter((item) => selectedIds.includes(item.id));
  const selectedGroupLayers = selectedGroupId ? draft.layers.filter((item) => item.groupId === selectedGroupId) : [];
  const templateGifFrameCount = Math.max(0, ...draft.layers.map((layer) => Number(layer.gifFrameCount) || 0), gifTimeline.frames.length);
  const uniformlySelectedGroupId = selectedLayers.length && selectedLayers.every((item) => item.groupId && item.groupId === selectedLayers[0].groupId) ? selectedLayers[0].groupId : null;
  const updateDraft = useCallback((updater) => { commitDraft(updater); setDirty(true); setAutosaveState('pending'); }, [commitDraft]);
  const updateLayer = (id, patch) => updateDraft((prev) => ({ ...prev, layers: prev.layers.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const updateLayers = useCallback((patches) => updateDraft((previous) => ({
    ...previous,
    layers: previous.layers.map((layer) => patches[layer.id] ? { ...layer, ...patches[layer.id] } : layer)
  })), [updateDraft]);
  const undoDraft = useCallback(() => { if (undo()) { setDirty(true); setAutosaveState('pending'); } }, [undo]);
  const redoDraft = useCallback(() => { if (redo()) { setDirty(true); setAutosaveState('pending'); } }, [redo]);
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setSelectedGroupId(null);
    setSelectedGroupIds([]);
    groupSelectionAnchorRef.current = null;
    setTextEditingId(null);
    setTextSelection(null);
    setPropertyTextSelection(null);
  }, []);
  const selectLayer = useCallback((id, event = {}) => {
    const layer = draft.layers.find((item) => item.id === id);
    if (!layer) return;
    setLayerMenu(null);
    if (event.shiftKey) event.preventDefault?.();
    setTextEditingId((current) => current === id ? current : null);
    setTextSelection((current) => current?.id === id ? current : null);
    setPropertyTextSelection((current) => current?.id === id ? current : null);
    const rangeSelect = event.shiftKey && !event.ctrlKey && !event.metaKey;
    const additive = event.ctrlKey || event.metaKey;
    setSelectedGroupId(null);
    setSelectedGroupIds([]);
    if (!rangeSelect) selectionAnchorRef.current = id;
    setSelectedIds((current) => {
      if (rangeSelect) {
        const entries = [];
        const seen = new Set();
        [...draft.layers].reverse().forEach((item) => {
          if (!item.groupId) { entries.push([item.id]); return; }
          if (seen.has(item.groupId)) return;
          seen.add(item.groupId);
          const members = draft.layers.filter((candidate) => candidate.groupId === item.groupId).reverse().map((candidate) => candidate.id);
          if (collapsedGroups.has(item.groupId)) entries.push(members);
          else members.forEach((memberId) => entries.push([memberId]));
        });
        const anchorId = selectionAnchorRef.current || current.at(-1) || id;
        const anchorIndex = entries.findIndex((entry) => entry.includes(anchorId));
        const targetIndex = entries.findIndex((entry) => entry.includes(id));
        if (anchorIndex < 0 || targetIndex < 0) return [id];
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        return [...new Set(entries.slice(start, end + 1).flat())];
      }
      if (!additive) return [id];
      return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    });
  }, [collapsedGroups, draft.layers]);
  const selectGroup = useCallback((groupId, event = {}) => {
    const memberIds = draft.layers.filter((item) => item.groupId === groupId).map((item) => item.id);
    if (!memberIds.length) return;
    setLayerMenu(null);
    if (event.shiftKey) event.preventDefault?.();
    const groupOrder = [];
    const seen = new Set();
    [...draft.layers].reverse().forEach((layer) => {
      if (!layer.groupId || seen.has(layer.groupId)) return;
      seen.add(layer.groupId);
      groupOrder.push(layer.groupId);
    });
    const additive = event.ctrlKey || event.metaKey;
    const rangeSelect = event.shiftKey && !additive;
    if (!rangeSelect) groupSelectionAnchorRef.current = groupId;
    setSelectedGroupIds((current) => {
      let next;
      if (rangeSelect) {
        const anchor = groupSelectionAnchorRef.current || current.at(-1) || groupId;
        const anchorIndex = groupOrder.indexOf(anchor);
        const targetIndex = groupOrder.indexOf(groupId);
        if (anchorIndex < 0 || targetIndex < 0) next = [groupId];
        else next = groupOrder.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
      } else if (additive) {
        next = current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId];
      } else {
        next = [groupId];
      }
      const nextMemberIds = draft.layers.filter((layer) => layer.groupId && next.includes(layer.groupId)).map((layer) => layer.id);
      setSelectedIds(nextMemberIds);
      setSelectedGroupId(next.length === 1 ? next[0] : null);
      return next;
    });
  }, [draft.layers]);
  const copyLayersByIds = useCallback((ids) => {
    const layers = draft.layers.filter((item) => ids.includes(item.id));
    if (!layers.length) return;
    const idSet = new Set(ids);
    const groupIds = new Set(layers.map((layer) => layer.groupId).filter((groupId) => groupId && draft.layers.filter((candidate) => candidate.groupId === groupId).every((candidate) => idSet.has(candidate.id))));
    clipboardLayersRef.current = {
      layers: structuredClone(layers.map((layer) => layer.groupId && !groupIds.has(layer.groupId) ? { ...layer, groupId: undefined } : layer)),
      groupMeta: Object.fromEntries([...groupIds].map((groupId) => [groupId, structuredClone(draft.groupMeta?.[groupId] || {})]))
    };
    setHasCopiedLayers(true);
    notify(layers.length === 1 ? `已复制图层“${layers[0].name}”` : `已复制 ${layers.length} 个图层`);
  }, [draft.groupMeta, draft.layers, notify]);
  const copySelectedLayers = useCallback(() => copyLayersByIds(selectedIds), [copyLayersByIds, selectedIds]);
  const normalizeMarqueeRect = useCallback((rect) => {
    const left = Math.floor(rect.x);
    const top = Math.floor(rect.y);
    const right = Math.ceil(rect.x + rect.width);
    const bottom = Math.ceil(rect.y + rect.height);
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }, []);
  const buildMarqueeFragments = useCallback(async (ids, rect) => {
    const selection = normalizeMarqueeRect(rect);
    const layers = draft.layers.filter((layer) => ids.includes(layer.id));
    const fragments = (await Promise.all(layers.map(async (layer) => {
      const rendered = await renderTemplate({
        width: selection.width,
        height: selection.height,
        layers: [{ ...structuredClone(layer), x: layer.x - selection.x, y: layer.y - selection.y, visible: true }]
      }, {}, {}, { transparent: true, mime: 'image/png' });
      const image = await loadImage(rendered);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, image.width); canvas.height = Math.max(1, image.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width; let top = canvas.height; let right = -1; let bottom = -1;
      for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
      if (right < left || bottom < top) return null;
      const width = right - left + 1; const height = bottom - top + 1;
      const trimmed = document.createElement('canvas'); trimmed.width = width; trimmed.height = height;
      trimmed.getContext('2d').drawImage(canvas, left, top, width, height, 0, 0, width, height);
      return {
        id: uid(), name: `${layer.name} 选区`, type: 'static', src: trimmed.toDataURL('image/png'),
        x: selection.x + left, y: selection.y + top, width, height,
        rotation: 0, opacity: 1, blendMode: 'source-over', aspectRatioLocked: true, visible: true, locked: false, fit: 'fill'
      };
    }))).filter(Boolean);
    return { fragments, selection };
  }, [draft.layers, normalizeMarqueeRect]);
  const copyMarqueePixels = useCallback(async (ids, rect) => {
    if (!ids.length || !rect) return;
    try {
      const { fragments } = await buildMarqueeFragments(ids, rect);
      if (!fragments.length) return;
      clipboardLayersRef.current = { layers: fragments, groupMeta: {} };
      setHasCopiedLayers(true);
      notify(fragments.length === 1 ? '已复制选框内容' : `已复制 ${fragments.length} 个图层的选框内容`);
    } catch (error) { notify(`复制选框内容失败：${error?.message || error}`, 'error'); }
  }, [buildMarqueeFragments, notify]);
  const cutMarqueePixels = useCallback(async (ids, rect) => {
    const layers = draft.layers.filter((layer) => ids.includes(layer.id) && !layer.locked && layer.width > 0 && layer.height > 0);
    if (!layers.length) return notify('选框内没有可剪切的未锁定图层', 'error');
    try {
      const { fragments, selection } = await buildMarqueeFragments(layers.map((layer) => layer.id), rect);
      const eraseSources = Object.fromEntries(await Promise.all(layers.map(async (layer) => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(layer.width));
        canvas.height = Math.max(1, Math.ceil(layer.height));
        const ctx = canvas.getContext('2d');
        ctx.scale(canvas.width / layer.width, canvas.height / layer.height);
        if (layer.eraseSrc) {
          const existingMask = await loadImage(layer.eraseSrc);
          ctx.drawImage(existingMask, 0, 0, layer.width, layer.height);
        }
        const radians = (Number(layer.rotation) || 0) * Math.PI / 180;
        const cosine = Math.cos(radians); const sine = Math.sin(radians);
        const toLocal = (x, y) => {
          const dx = x - layer.x; const dy = y - layer.y;
          return { x: dx * cosine + dy * sine, y: -dx * sine + dy * cosine };
        };
        const corners = [[selection.x, selection.y], [selection.x + selection.width, selection.y], [selection.x + selection.width, selection.y + selection.height], [selection.x, selection.y + selection.height]].map(([x, y]) => toLocal(x, y));
        ctx.fillStyle = '#000'; ctx.beginPath();
        corners.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        ctx.closePath(); ctx.fill();
        return [layer.id, canvas.toDataURL('image/png')];
      })));
      clipboardLayersRef.current = { layers: fragments, groupMeta: {} };
      setHasCopiedLayers(true);
      updateDraft((previous) => ({ ...previous, layers: previous.layers.map((layer) => eraseSources[layer.id] ? { ...layer, eraseSrc: eraseSources[layer.id] } : layer) }));
      notify(layers.length === 1 ? '已剪切选框内容' : `已剪切 ${layers.length} 个图层的选框内容`);
    } catch (error) { notify(`剪切选框内容失败：${error?.message || error}`, 'error'); }
  }, [buildMarqueeFragments, draft.layers, notify, updateDraft]);
  const pasteLayers = useCallback(() => {
    if (!clipboardLayersRef.current.layers.length) return notify('请先选择并复制图层', 'error');
    const groupMap = new Map();
    const layers = clipboardLayersRef.current.layers.map((copiedLayer) => {
      if (copiedLayer.groupId && !groupMap.has(copiedLayer.groupId)) groupMap.set(copiedLayer.groupId, uid());
      return {
        ...structuredClone(copiedLayer),
        id: uid(),
        opacity: layerOpacityOf(copiedLayer),
        groupId: copiedLayer.groupId ? groupMap.get(copiedLayer.groupId) : undefined,
        name: copiedLayer.groupId ? copiedLayer.name : `${copiedLayer.name} \u526f\u672c`,
        x: copiedLayer.x + 20,
        y: copiedLayer.y + 20
      };
    });
    const usedGroupNames = new Set(Object.values(draft.groupMeta || {}).map((meta) => String(meta?.name || '').trim()).filter(Boolean));
    const copiedGroupMeta = Object.fromEntries([...groupMap].map(([oldId, newId]) => {
      const sourceMeta = clipboardLayersRef.current.groupMeta[oldId] || {};
      const sourceName = String(sourceMeta.name || '图层组 1').trim();
      const defaultName = /^图层组\s+\d+$/.test(sourceName);
      let name = sourceName;
      if (defaultName) {
        let number = Number(sourceName.match(/(\d+)$/)?.[1] || 1) + 1;
        do { name = `图层组 ${number++}`; } while (usedGroupNames.has(name));
      } else {
        name = `${sourceName} 副本`;
      }
      usedGroupNames.add(name);
      return [newId, { ...structuredClone(sourceMeta), name }];
    }));
    updateDraft((previous) => {
      const selectedIndexes = previous.layers.map((layer, index) => selectedIds.includes(layer.id) ? index : -1).filter((index) => index >= 0);
      const insertAt = selectedIndexes.length ? Math.max(...selectedIndexes) + 1 : previous.layers.length;
      const nextLayers = [...previous.layers];
      nextLayers.splice(insertAt, 0, ...layers);
      return { ...previous, layers: nextLayers, groupMeta: { ...(previous.groupMeta || {}), ...copiedGroupMeta } };
    });
    clipboardLayersRef.current = { layers: structuredClone(layers), groupMeta: copiedGroupMeta };
    setHasCopiedLayers(true);
    setSelectedIds(layers.map((layer) => layer.id));
    setSelectedGroupId(groupMap.size === 1 ? [...groupMap.values()][0] : null);
    setActiveTool('select');
  }, [draft.groupMeta, notify, selectedIds, updateDraft]);
  const removeSelectedLayers = useCallback(() => {
    const removableIds = draft.layers.filter((layer) => selectedIds.includes(layer.id) && !layer.locked).map((layer) => layer.id);
    if (!removableIds.length) return notify('所选图层已锁定', 'error');
    updateDraft((previous) => {
      const layers = previous.layers.filter((layer) => !removableIds.includes(layer.id));
      const groupIds = new Set(layers.map((layer) => layer.groupId).filter(Boolean));
      const groupMeta = Object.fromEntries(Object.entries(previous.groupMeta || {}).filter(([id]) => groupIds.has(id)));
      return { ...previous, layers, groupMeta };
    });
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
  const tryBack = useCallback(async (event = {}) => {
    if (dirty) {
      const x = Number.isFinite(event.clientX) ? event.clientX : lastPointerRef.current.x;
      const y = Number.isFinite(event.clientY) ? event.clientY : lastPointerRef.current.y;
      setLeavePrompt({ x: clamp(x, 12, Math.max(12, window.innerWidth - 290)), y: clamp(y, 12, Math.max(12, window.innerHeight - 132)) });
      return;
    }
    await onClearDraft(draftKey).catch(() => undefined);
    onBack();
  }, [dirty, draftKey, onBack, onClearDraft]);

  useEffect(() => {
    const rememberPointer = (event) => { lastPointerRef.current = { x: event.clientX, y: event.clientY }; };
    window.addEventListener('pointermove', rememberPointer);
    return () => window.removeEventListener('pointermove', rememberPointer);
  }, []);

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

  const pasteGifFrame = async () => {
    if (!selectedGifLayer || !gifTimeline.frames.length) return false;
    try {
      const dataUrl = await desktop.readClipboardImage();
      if (!dataUrl) return false;
      const decoded = isGifSource(dataUrl) ? await desktop.decodeGifFrames(dataUrl) : null;
      await insertGifFrame(decoded?.frames?.[0]?.dataUrl || dataUrl, gifTimeline.frameIndex);
      return true;
    } catch (error) { notify(`粘贴 GIF 帧失败：${error?.message || error}`, 'error'); return true; }
  };
  useEffect(() => {
    const handleKeyDown = async (event) => {
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
          const nativeSelection = window.getSelection?.();
          if (nativeSelection?.toString()) return;
          event.preventDefault(); copySelectedLayers();
          return;
        }
        if (event.key.toLowerCase() === 'v') {
          event.preventDefault();
          if (selectedGifLayer && gifTimeline.layerId === selectedGifLayer.id && gifTimeline.frames.length) await pasteGifFrame(); else pasteLayers();
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
        if (textEditingId) {
          setTextEditingId(null);
          setTextSelection(null);
        } else if (activeTool === 'text') {
          setActiveTool('select');
          setTextMenu(false);
        } else tryBack();
      }
    };
    const closeMenus = () => { setShapeMenu(false); setLayerMenu(null); setFixedLayerMenu(false); setEraserMenu(false); setTextMenu(false); };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', closeMenus);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('pointerdown', closeMenus); };
  }, [activeTool, copySelectedLayers, gifTimeline, nudgeSelectedLayers, pasteLayers, redoDraft, removeSelectedLayers, selectedGifLayer, selectedIds.length, textEditingId, tryBack, undoDraft]);

  useEffect(() => {
    if (activeTool !== 'text') return undefined;
    const exitTextTool = (event) => { if (!event.target.closest?.('.canvas-scroll, .text-add-wrap')) { setActiveTool('select'); setTextMenu(false); } };
    window.addEventListener('pointerdown', exitTextTool);
    return () => window.removeEventListener('pointerdown', exitTextTool);
  }, [activeTool]);

  useEffect(() => {
    if (!['select', 'picker', 'marquee', 'text'].includes(activeTool) && (selectedLayers.length !== 1 || selected?.locked)) setActiveTool('select');
  }, [activeTool, selected, selectedLayers.length]);

  useEffect(() => {
    if (activeTool === 'select' || !textEditingId) return;
    setTextEditingId(null);
    setTextSelection(null);
  }, [activeTool, textEditingId]);

  useEffect(() => {
    const available = new Set(draft.layers.map((layer) => layer.id));
    setSelectedIds((current) => current.filter((id) => available.has(id)));
    const groups = new Set(draft.layers.map((layer) => layer.groupId).filter(Boolean));
    if (selectedGroupId && !groups.has(selectedGroupId)) setSelectedGroupId(null);
    setSelectedGroupIds((current) => {
      const next = current.filter((groupId) => groups.has(groupId));
      if (next.length !== current.length) {
        setSelectedGroupId(next.length === 1 ? next[0] : null);
        setSelectedIds(draft.layers.filter((layer) => layer.groupId && next.includes(layer.groupId)).map((layer) => layer.id));
      }
      return next.length === current.length ? current : next;
    });
    setCollapsedGroups((current) => {
      const next = new Set([...groups].filter((groupId) => draft.groupMeta?.[groupId]?.collapsed));
      return next.size === current.size && [...next].every((groupId) => current.has(groupId)) ? current : next;
    });
  }, [draft.layers, selectedGroupId]);

  const addImage = async (file, dropPoint = null, { asGif = false, insertIndex = null, groupId = null } = {}) => {
    try {
      let src = await fileToDataUrl(file);
      const image = await loadImage(src);
      const pseudoGif = /\.gif$/i.test(file?.name || '') && !isGifSource(src);
      const createdSingleFrameGif = (asGif || pseudoGif) && !isGifSource(src);
      if (createdSingleFrameGif) src = await createGifSourceFromImage(src);
      if (pseudoGif) notify('检测到该文件是伪 GIF，已转换为单帧 GIF（100ms）');
      const initializeCanvas = !draft.layers.length && draft.width === 0 && draft.height === 0;
      const initialWidth = Math.min(4000, image.width); const initialHeight = Math.min(4000, image.height);
      const maxW = initializeCanvas ? initialWidth : Math.max(1, draft.width * .9); const maxH = initializeCanvas ? initialHeight : Math.max(1, draft.height * .9);
      const scale = Math.min(maxW / image.width, maxH / image.height, 1);
      const width = Math.round(image.width * scale); const height = Math.round(image.height * scale);
      const x = initializeCanvas ? 0 : Math.round((dropPoint?.x ?? draft.width / 2) - width / 2);
      const y = initializeCanvas ? 0 : Math.round((dropPoint?.y ?? draft.height / 2) - height / 2);
      const layer = { id: uid(), name: file.name.replace(/\.[^.]+$/, ''), type: 'static', src, x, y, width, height, rotation: 0, opacity: 1, blendMode: 'source-over', aspectRatioLocked: true, visible: true, fit: 'fill', ...(groupId ? { groupId } : {}), ...(createdSingleFrameGif ? { gifFrameCount: 1, gifFrameDelays: [100] } : {}) };
      updateDraft((prev) => {
        const layers = [...prev.layers];
        const resolvedIndex = Number.isInteger(insertIndex) ? clamp(insertIndex, 0, layers.length) : layers.length;
        layers.splice(resolvedIndex, 0, layer);
        return { ...prev, width: initializeCanvas ? width : prev.width, height: initializeCanvas ? height : prev.height, layers };
      });
      setSelectedIds([layer.id]); setSelectedGroupId(null); setActiveTool('select');
    } catch (error) { notify(error.message, 'error'); }
  };

  const dropImageOnEditor = async (event) => {
    const file = Array.from(event.dataTransfer?.files || []).find((item) => isImageFileLike(item));
    if (!file) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = stageHostRef.current?.getBoundingClientRect();
    const dropPoint = bounds ? { x: (event.clientX - bounds.left) / zoom, y: (event.clientY - bounds.top) / zoom } : null;
    await addImage(file, dropPoint);
  };

  const isGifFrameDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('application/x-meme-gif-frame');
  const resolveGifFrameLayerDrop = (event) => {
    const list = event.currentTarget;
    const rows = [...list.querySelectorAll('[data-layer-id]')];
    if (!rows.length) return { id: null, placement: 'before', groupId: null, parentGroupId: null };
    let row = event.target instanceof Element ? event.target.closest('[data-layer-id]') : null;
    if (!row || !list.contains(row)) {
      row = rows.find((candidate) => event.clientY < candidate.getBoundingClientRect().top + candidate.getBoundingClientRect().height / 2) || rows.at(-1);
    }
    const rect = row.getBoundingClientRect();
    return {
      id: row.dataset.layerId || null,
      placement: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
      groupId: row.dataset.groupId || null,
      parentGroupId: row.dataset.parentGroupId || null
    };
  };
  const handleGifFrameLayerDragOver = (event) => {
    if (!isGifFrameDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setGifFrameLayerDrop(resolveGifFrameLayerDrop(event));
  };
  const handleGifFrameLayerDrop = async (event) => {
    if (!isGifFrameDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    const drop = resolveGifFrameLayerDrop(event);
    const sourceIndex = Number(event.dataTransfer.getData('application/x-meme-gif-frame'));
    const frame = gifTimeline.frames[sourceIndex];
    setGifFrameLayerDrop(null);
    if (!frame) return;
    const targetIndex = drop.id ? draft.layers.findIndex((layer) => layer.id === drop.id) : draft.layers.length;
    let insertIndex = targetIndex < 0 ? draft.layers.length : drop.placement === 'before' ? targetIndex + 1 : targetIndex;
    let targetGroupId = drop.parentGroupId || null;
    if (drop.groupId) {
      const groupIndexes = draft.layers.map((layer, index) => layer.groupId === drop.groupId ? index : -1).filter((index) => index >= 0);
      if (groupIndexes.length) insertIndex = drop.placement === 'before' ? Math.max(...groupIndexes) + 1 : Math.min(...groupIndexes);
      targetGroupId = null;
    }
    try {
      const file = dataUrlToFile(frame.dataUrl, `GIF 帧 ${sourceIndex + 1}.png`);
      await addImage(file, null, { insertIndex, groupId: targetGroupId });
    } catch (error) { notify(`添加 GIF 帧失败：${error?.message || error}`, 'error'); }
  };
  const addEmptySlot = (shape) => {
    const initializeCanvas = !draft.layers.length && draft.width === 0 && draft.height === 0;
    const size = initializeCanvas ? 416 : Math.round(Math.min(draft.width, draft.height) * .52);
    const width = size;
    const height = size;
    const shapeName = shape === 'circle' ? '圆形' : shape === 'rounded' ? '圆角矩形' : shape === 'polygon' ? '多边形' : '矩形';
    const layer = { id: uid(), name: `${shapeName}照片 ${draft.layers.filter((x) => x.type === 'slot').length + 1}`, type: 'slot', shape, src: '', x: initializeCanvas ? 0 : Math.round((draft.width - width) / 2), y: initializeCanvas ? 0 : Math.round((draft.height - height) / 2), width, height, rotation: 0, opacity: 1, blendMode: 'source-over', aspectRatioLocked: true, visible: true, fit: 'cover', multiPhotoLayout: 'none', multiPhotoColumns: 2, ...(shape === 'polygon' ? { polygonSides: 5, polygonPoints: regularPolygonPoints(5) } : shape === 'rounded' ? { cornerRadius: 36 } : {}) };
    updateDraft((prev) => ({ ...prev, width: initializeCanvas ? width : prev.width, height: initializeCanvas ? height : prev.height, layers: [...prev.layers, layer] })); setSelectedIds([layer.id]); setSelectedGroupId(null);
    setShapeMenu(false); setActiveTool('select');
  };

  const addTextLayer = (point = null, orientation = textOrientation) => {
    const initializeCanvas = !draft.layers.length && draft.width === 0 && draft.height === 0;
    const seed = { id: uid(), name: `文字 ${draft.layers.filter((item) => item.type === 'text').length + 1}`, type: 'text', text: '输入文字', textOrientation: orientation, x: initializeCanvas ? 0 : Math.round(point?.x ?? draft.width * .18), y: initializeCanvas ? 0 : Math.round(point?.y ?? draft.height * .18), width: 1, height: 1, rotation: 0, opacity: 1, blendMode: 'source-over', aspectRatioLocked: true, visible: true, fontSize: 48, fontFamily: 'Microsoft YaHei', fontStyle: 'normal', textDecoration: '', align: 'center', fill: '#22211f', lineHeight: 1.25, autoFit: false, stroke: '#ffffff', strokeWidth: 0, shadowEnabled: false, shadowColor: '#000000', shadowBlur: 8, shadowOffsetX: 2, shadowOffsetY: 2, background: '', backgroundPadding: 8 };
    seed.name = `文字 ${draft.layers.filter((item) => item.type === 'text').length + 1}`;
    const layer = fitTextLayerToContent(seed);
    updateDraft((prev) => ({ ...prev, width: initializeCanvas ? layer.width : prev.width, height: initializeCanvas ? layer.height : prev.height, layers: [...prev.layers, layer] }));
    setSelectedIds([layer.id]); setSelectedGroupId(null); setTextEditingId(layer.id); setTextSelection({ id: layer.id, start: 0, end: String(layer.text).length }); setPropertyTextSelection(null); setTextMenu(false); setActiveTool('select');
  };

  const autoSizeCanvas = () => {
    const bounds = combinedLayerBounds(draft.layers);
    if (!bounds) return notify('请先添加图层', 'error');
    const left = Math.floor(bounds.left); const top = Math.floor(bounds.top);
    const width = Math.min(4000, Math.max(0, Math.ceil(bounds.right) - left));
    const height = Math.min(4000, Math.max(0, Math.ceil(bounds.bottom) - top));
    updateDraft((previous) => ({
      ...previous,
      width,
      height,
      layers: previous.layers.map((layer) => ({ ...layer, x: layer.x - left, y: layer.y - top }))
    }));
  };

  const editTextLayer = useCallback((id) => {
    const layer = draft.layers.find((item) => item.id === id && item.type === 'text' && !item.locked);
    if (!layer) return;
    setSelectedIds([id]);
    setSelectedGroupId(null);
    setTextEditingId(id);
    setTextSelection({ id, start: 0, end: String(layer.text || '').length });
    setPropertyTextSelection(null);
    setActiveTool('select');
  }, [draft.layers]);

  const beginPropertyTextInteraction = useCallback(() => {
    setTextEditingId(null);
    setTextSelection(null);
  }, []);

  const applySelectedTextStyle = useCallback((patch) => {
    if (!selected || selected.type !== 'text') return;
    let selection = activeTextSelection;
    if ('lineHeight' in patch && selection && selection.start !== selection.end) {
      const text = String(selected.text || '');
      const rawStart = Math.min(selection.start, selection.end);
      const rawEnd = Math.max(selection.start, selection.end);
      const lineStart = text.lastIndexOf('\n', Math.max(0, rawStart - 1)) + 1;
      const nextBreak = text.indexOf('\n', rawEnd);
      selection = { ...selection, start: lineStart, end: nextBreak < 0 ? text.length : nextBreak };
    }
    updateDraft((previous) => ({
      ...previous,
      layers: previous.layers.map((layer) => layer.id === selected.id
        ? fitTextLayerToContent({ ...layer, ...applyTextStyle(layer, selection, patch) })
        : layer)
    }));
  }, [activeTextSelection, selected, updateDraft]);

  const updateSelectedText = useCallback((text) => {
    if (!selected || selected.type !== 'text') return;
    updateDraft((previous) => ({
      ...previous,
      layers: previous.layers.map((layer) => layer.id === selected.id
        ? fitTextLayerToContent({ ...layer, ...updateTextContent(layer, text) })
        : layer)
    }));
  }, [selected, updateDraft]);

  const updateSelectedProperties = useCallback((patch) => {
    if (!selected) return;
    updateDraft((previous) => ({
      ...previous,
      layers: previous.layers.map((layer) => {
        if (layer.id !== selected.id) return layer;
        const next = { ...layer, ...patch };
        return layer.type === 'text' && Object.keys(patch).some((key) => ['backgroundPadding'].includes(key)) ? fitTextLayerToContent(next) : next;
      })
    }));
  }, [selected, updateDraft]);

  const openLayerMenu = (id, event) => {
    event.preventDefault(); event.stopPropagation();
    if (!selectedIds.includes(id)) selectLayer(id, event);
    setLayerMenu({ id, x: Math.min(event.clientX, window.innerWidth - 166), y: Math.min(event.clientY, window.innerHeight - 334) });
  };
  const openGroupMenu = (groupId, event) => {
    event.preventDefault(); event.stopPropagation();
    const members = draft.layers.filter((item) => item.groupId === groupId);
    if (!members.length) return;
    if (selectedGroupId !== groupId) selectGroup(groupId, event);
    setLayerMenu({ id: members.at(-1).id, groupId, x: Math.min(event.clientX, window.innerWidth - 166), y: Math.min(event.clientY, window.innerHeight - 334) });
  };
  const openLayersBlankMenu = (event) => {
    if (!hasCopiedLayers) return;
    if (event.target.closest('button, input, textarea, select, [data-layer-id], [data-group-id], .panel-title, .layer-add-row, .template-tags-field')) return;
    event.preventDefault(); event.stopPropagation();
    clearSelection();
    setLayerMenu({ blank: true, x: Math.min(event.clientX, window.innerWidth - 166), y: Math.min(event.clientY, window.innerHeight - 54) });
  };
  const openMarqueeMenu = (ids, rect, event) => {
    event.preventDefault(); event.stopPropagation();
    setLayerMenu({ marquee: { ids, rect: { ...rect } }, x: Math.min(event.clientX, window.innerWidth - 206), y: Math.min(event.clientY, window.innerHeight - 120) });
  };

  const removeLayer = (id) => {
    const layer = draft.layers.find((item) => item.id === id);
    if (layer?.locked) return notify('请先解锁图层', 'error');
    updateDraft((prev) => {
      const layers = prev.layers.filter((x) => x.id !== id);
      const groupIds = new Set(layers.map((item) => item.groupId).filter(Boolean));
      const groupMeta = Object.fromEntries(Object.entries(prev.groupMeta || {}).filter(([groupId]) => groupIds.has(groupId)));
      return { ...prev, layers, groupMeta };
    });
    setSelectedIds((current) => current.filter((item) => item !== id));
  };
  const moveLayer = (id, direction, wholeGroup = false) => updateDraft((prev) => {
    const source = prev.layers.find((item) => item.id === id);
    if (!source) return prev;
    const index = prev.layers.findIndex((item) => item.id === id);
    if (!wholeGroup && source.groupId) {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= prev.layers.length || prev.layers[targetIndex].groupId !== source.groupId || source.locked) return prev;
      const layers = [...prev.layers];
      [layers[index], layers[targetIndex]] = [layers[targetIndex], layers[index]];
      return { ...prev, layers };
    }
    const ids = wholeGroup && source.groupId ? prev.layers.filter((item) => item.groupId === source.groupId).map((item) => item.id) : [id];
    const indexes = prev.layers.map((item, index) => ids.includes(item.id) ? index : -1).filter((index) => index >= 0);
    if (!indexes.length || ids.some((itemId) => prev.layers.find((item) => item.id === itemId)?.locked)) return prev;
    const first = Math.min(...indexes); const last = Math.max(...indexes);
    const adjacent = prev.layers[direction > 0 ? last + 1 : first - 1];
    if (!adjacent) return prev;
    const targetIds = adjacent.groupId ? prev.layers.filter((item) => item.groupId === adjacent.groupId).map((item) => item.id) : [adjacent.id];
    const moving = prev.layers.filter((item) => ids.includes(item.id));
    const layers = prev.layers.filter((item) => !ids.includes(item.id));
    const targetStart = layers.findIndex((item) => targetIds.includes(item.id));
    if (targetStart < 0) return prev;
    const targetEnd = targetStart + targetIds.length - 1;
    layers.splice(direction > 0 ? targetEnd + 1 : targetStart, 0, ...moving);
    return { ...prev, layers };
  });
  const reorderLayer = (sourceId, targetId, placement, wholeGroup = false, selectedIdsOverride = null, targetGroupIdOverride = null, selectedGroupIdsOverride = null) => {
    if (!sourceId || (sourceId === targetId && !(placement === 'inside' && selectedIdsOverride?.some((id) => id !== sourceId)))) return;
    const movedSelectionIds = selectedGroupIdsOverride?.length
      ? draft.layers.filter((item) => item.groupId && selectedGroupIdsOverride.includes(item.groupId)).map((item) => item.id)
      : wholeGroup
        ? draft.layers.filter((item) => item.groupId && item.groupId === draft.layers.find((layer) => layer.id === sourceId)?.groupId).map((item) => item.id)
      : selectedIdsOverride?.length ? [...selectedIdsOverride] : [sourceId];
    updateDraft((previous) => {
      const source = previous.layers.find((item) => item.id === sourceId);
      const target = previous.layers.find((item) => item.id === targetId);
      if (!source || !target) return previous;
      const sourceGroupIds = selectedGroupIdsOverride?.length
        ? selectedGroupIdsOverride
        : wholeGroup && source.groupId ? [source.groupId] : [];
      const sourceIds = sourceGroupIds.length
        ? previous.layers.filter((item) => item.groupId && sourceGroupIds.includes(item.groupId)).map((item) => item.id)
        : selectedIdsOverride?.length ? previous.layers.filter((item) => selectedIdsOverride.includes(item.id)).map((item) => item.id) : [sourceId];
      const targetGroupId = targetGroupIdOverride || target.groupId || null;
      const movingIntoTargetGroup = Boolean(targetGroupIdOverride && targetGroupIdOverride !== source.groupId);
      if (!wholeGroup && !selectedGroupIdsOverride?.length && source.groupId && target.groupId && target.groupId !== source.groupId && placement !== 'inside' && !movingIntoTargetGroup) return previous;
      if (placement === 'inside' && target.groupId) {
        if (sourceIds.some((id) => previous.layers.find((item) => item.id === id)?.locked)) return previous;
        const groupMembers = previous.layers.filter((item) => item.groupId === target.groupId);
        const moving = previous.layers.filter((item) => sourceIds.includes(item.id)).map((item) => ({ ...item, groupId: target.groupId }));
        const without = previous.layers.filter((item) => !sourceIds.includes(item.id));
        const insertAt = without.findIndex((item) => item.id === groupMembers.at(-1)?.id);
        without.splice(insertAt < 0 ? without.length : insertAt + 1, 0, ...moving);
        return { ...previous, layers: without };
      }
      if (movingIntoTargetGroup) {
        if (sourceIds.some((id) => previous.layers.find((item) => item.id === id)?.locked)) return previous;
        const moving = previous.layers.filter((item) => sourceIds.includes(item.id)).map((item) => ({ ...item, groupId: targetGroupId }));
        const layers = previous.layers.filter((item) => !sourceIds.includes(item.id));
        const targetIndex = layers.findIndex((item) => item.id === targetId);
        if (targetIndex < 0) return previous;
        layers.splice(placement === 'before' ? targetIndex + 1 : targetIndex, 0, ...moving);
        return { ...previous, layers };
      }
      const targetIds = !wholeGroup && !selectedGroupIdsOverride?.length && source.groupId
        ? [targetId]
        : targetGroupId
        ? previous.layers.filter((item) => item.groupId === targetGroupId).map((item) => item.id)
        : [targetId];
      if (sourceIds.some((id) => targetIds.includes(id)) || sourceIds.some((id) => previous.layers.find((item) => item.id === id)?.locked)) return previous;
      const detachFromGroup = !wholeGroup && source.groupId && !target.groupId;
      const moving = previous.layers.filter((item) => sourceIds.includes(item.id)).map((item) => detachFromGroup ? { ...item, groupId: undefined } : item);
      const layers = previous.layers.filter((item) => !sourceIds.includes(item.id));
      const targetStart = layers.findIndex((item) => targetIds.includes(item.id));
      const targetEnd = targetStart + targetIds.length - 1;
      if (targetStart < 0) return previous;
      layers.splice(placement === 'before' ? targetEnd + 1 : targetStart, 0, ...moving);
      return { ...previous, layers };
    });
    const sourceLayer = draft.layers.find((item) => item.id === sourceId);
    setSelectedIds(movedSelectionIds);
    const movedGroupIds = selectedGroupIdsOverride?.length
      ? [...selectedGroupIdsOverride]
      : wholeGroup ? (sourceLayer?.groupId ? [sourceLayer.groupId] : []) : [];
    setSelectedGroupIds(movedGroupIds);
    setSelectedGroupId(movedGroupIds.length === 1 ? movedGroupIds[0] : null);
  };
  const resolveTimelineLayerInsertion = (pointerEvent) => {
    if (!timelineGifLayer || !gifTimeline.frames.length) return null;
    const strip = document.querySelector('.gif-frame-strip');
    const rect = strip?.getBoundingClientRect();
    if (!strip || !rect || pointerEvent.clientX < rect.left || pointerEvent.clientX > rect.right || pointerEvent.clientY < rect.top || pointerEvent.clientY > rect.bottom) return null;
    const cells = [...strip.querySelectorAll('.gif-frame-cell')];
    for (let index = 0; index < cells.length; index += 1) {
      const cellRect = cells[index].getBoundingClientRect();
      if (pointerEvent.clientX < cellRect.left + cellRect.width / 2) return index;
    }
    return cells.length;
  };
  const beginLayerReorder = (event, sourceId, sourceGroupId = null) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const dragSelectedGroupIds = sourceGroupId && selectedGroupIds.includes(sourceGroupId)
      ? [...selectedGroupIds]
      : sourceGroupId ? [sourceGroupId] : null;
    const dragSelectedIds = sourceGroupId
      ? draft.layers.filter((item) => item.groupId && dragSelectedGroupIds.includes(item.groupId)).map((item) => item.id)
      : selectedIds.includes(sourceId) && selectedIds.length > 1 ? [...selectedIds] : null;
    if (sourceGroupId) {
      if (!selectedGroupIds.includes(sourceGroupId)) selectGroup(sourceGroupId, event);
    } else if (!selectedIds.includes(sourceId)) {
      selectLayer(sourceId, event);
    }
    const start = { x: event.clientX, y: event.clientY };
    const resolveTarget = (pointerEvent) => {
      let row = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest('[data-layer-id]');
      let edgePlacement = null;
      if (!row) {
        const list = document.querySelector('.layers-list');
        const listRect = list?.getBoundingClientRect();
        if (listRect && pointerEvent.clientY >= listRect.top && pointerEvent.clientY <= listRect.bottom) {
          const rows = [...list.querySelectorAll('[data-layer-id]')];
          if (rows.length) {
            const first = rows[0]; const last = rows.at(-1);
            const firstRect = first.getBoundingClientRect(); const lastRect = last.getBoundingClientRect();
            if (pointerEvent.clientY < firstRect.top) { row = first; edgePlacement = 'before'; }
            else if (pointerEvent.clientY > lastRect.bottom) { row = last; edgePlacement = 'after'; }
          }
        }
      }
      let targetId = row?.dataset.layerId;
      if (!targetId || (targetId === sourceId && !dragSelectedIds?.some((id) => id !== sourceId))) return null;
      const target = draft.layers.find((item) => item.id === targetId);
      if (sourceGroupId && target?.groupId === sourceGroupId) return null;
      // A child row carries data-parent-group-id; a group header carries
      // data-group-id. Keep the actual child row as the target so the same
      // before/after indicator used for normal sorting is shown inside a
      // group instead of always falling back to the group's first member.
      const childTargetGroupId = row?.dataset.parentGroupId || null;
      const headerTargetGroupId = row?.dataset.groupId || null;
      const targetGroupId = childTargetGroupId || headerTargetGroupId;
      const draggedLayersOutsideTargetGroup = (dragSelectedIds || [sourceId]).some((id) => draft.layers.find((item) => item.id === id)?.groupId !== targetGroupId);
      if (!sourceGroupId && childTargetGroupId && draggedLayersOutsideTargetGroup) {
        const rect = row.getBoundingClientRect();
        return {
          id: targetId,
          placement: edgePlacement || (pointerEvent.clientY < rect.top + rect.height / 2 ? 'before' : 'after'),
          targetGroupId: childTargetGroupId
        };
      }
      if (!sourceGroupId && headerTargetGroupId && draggedLayersOutsideTargetGroup) {
        const groupMembers = draft.layers.filter((item) => item.groupId === targetGroupId);
        return { id: groupMembers.at(-1)?.id || targetId, placement: 'inside', targetGroupId: headerTargetGroupId };
      }
      let rect = row.getBoundingClientRect();
      if (sourceGroupId && target?.groupId) {
        targetId = draft.layers.filter((item) => item.groupId === target.groupId).at(-1)?.id || targetId;
        const groupRows = [...document.querySelectorAll('[data-group-id], [data-parent-group-id]')].filter((item) => item.dataset.groupId === target.groupId || item.dataset.parentGroupId === target.groupId);
        if (groupRows.length) {
          const rects = groupRows.map((item) => item.getBoundingClientRect());
          const top = Math.min(...rects.map((item) => item.top));
          const bottom = Math.max(...rects.map((item) => item.bottom));
          rect = { top, height: bottom - top };
        }
      }
      return { id: targetId, placement: edgePlacement || (pointerEvent.clientY < rect.top + rect.height / 2 ? 'before' : 'after'), targetGroupId: sourceGroupId ? null : childTargetGroupId };
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      layerReorderRef.current = null;
    };
    const move = (pointerEvent) => {
      if (!layerReorderRef.current?.active && Math.hypot(pointerEvent.clientX - start.x, pointerEvent.clientY - start.y) < 4) return;
      if (layerReorderRef.current) layerReorderRef.current.active = true;
      pointerEvent.preventDefault();
      setDraggedLayerId(sourceId);
      const timelineInsertionIndex = sourceGroupId ? null : resolveTimelineLayerInsertion(pointerEvent);
      setTimelineLayerInsertionIndex(timelineInsertionIndex);
      if (timelineInsertionIndex != null) {
        setLayerDrop(null);
        return;
      }
      const target = resolveTarget(pointerEvent);
      setLayerDrop((current) => current?.id === target?.id && current?.placement === target?.placement ? current : target);
    };
    const finish = (pointerEvent) => {
      const active = layerReorderRef.current?.active;
      const timelineInsertionIndex = sourceGroupId ? null : resolveTimelineLayerInsertion(pointerEvent);
      const target = resolveTarget(pointerEvent);
      cleanup();
      if (active && timelineInsertionIndex != null) {
        insertLayerIntoGifTimeline(sourceId, timelineInsertionIndex);
      } else if (active && target) {
        reorderLayer(sourceId, target.id, target.placement, Boolean(sourceGroupId), dragSelectedIds, target.targetGroupId || null, dragSelectedGroupIds);
      }
      setDraggedLayerId(null);
      setLayerDrop(null);
      setTimelineLayerInsertionIndex(null);
    };
    layerReorderRef.current?.cleanup?.();
    layerReorderRef.current = { active: false, cleanup };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  };
  const groupSelected = () => {
    if (selectedIds.length < 2) return;
    const groupId = uid();
    updateDraft((previous) => {
      const selected = new Set(selectedIds);
      const firstIndex = previous.layers.findIndex((layer) => selected.has(layer.id));
      const moving = previous.layers.filter((layer) => selected.has(layer.id)).map((layer) => ({ ...layer, groupId }));
      const layers = previous.layers.filter((layer) => !selected.has(layer.id));
      layers.splice(Math.max(0, firstIndex), 0, ...moving);
      const groupCount = new Set(previous.layers.map((layer) => layer.groupId).filter(Boolean)).size;
      const activeGroupIds = new Set(layers.map((layer) => layer.groupId).filter(Boolean));
      const groupMeta = Object.fromEntries(Object.entries(previous.groupMeta || {}).filter(([id]) => activeGroupIds.has(id)));
      return { ...previous, layers, groupMeta: { ...groupMeta, [groupId]: { name: `图层组 ${groupCount + 1}` } } };
    });
    setCollapsedGroups((current) => { const next = new Set(current); next.delete(groupId); return next; });
    setSelectedGroupId(groupId);
  };
  const ungroupGroup = (groupId) => {
    if (!groupId) return;
    updateDraft((previous) => {
      const groupMeta = { ...(previous.groupMeta || {}) };
      delete groupMeta[groupId];
      return { ...previous, groupMeta, layers: previous.layers.map((layer) => layer.groupId === groupId ? { ...layer, groupId: undefined } : layer) };
    });
    setCollapsedGroups((current) => { const next = new Set(current); next.delete(groupId); return next; });
    setSelectedGroupId(null);
  };
  const ungroupSelected = () => ungroupGroup(selectedGroupId || uniformlySelectedGroupId);
  const toggleSelectedLock = () => {
    if (!selectedIds.length) return;
    const lock = selectedLayers.some((layer) => !layer.locked);
    updateDraft((previous) => ({ ...previous, layers: previous.layers.map((layer) => selectedIds.includes(layer.id) ? { ...layer, locked: lock } : layer) }));
  };
  const updateGroupMeta = (groupId, patch) => updateDraft((previous) => ({
    ...previous,
    groupMeta: { ...(previous.groupMeta || {}), [groupId]: { ...(previous.groupMeta?.[groupId] || {}), ...patch } }
  }));
  const updateGroupLayers = (groupId, patch) => updateDraft((previous) => ({
    ...previous,
    layers: previous.layers.map((layer) => layer.groupId === groupId ? { ...layer, ...patch } : layer)
  }));
  const removeGroup = (groupId) => {
    const members = draft.layers.filter((layer) => layer.groupId === groupId);
    if (members.some((layer) => layer.locked)) return notify('组内含有锁定图层，请先解锁', 'error');
    const removeIds = members.map((layer) => layer.id);
    updateDraft((previous) => {
      const groupMeta = { ...(previous.groupMeta || {}) };
      delete groupMeta[groupId];
      return { ...previous, groupMeta, layers: previous.layers.filter((layer) => layer.groupId !== groupId) };
    });
    setSelectedIds((current) => current.filter((id) => !removeIds.includes(id)));
    setSelectedGroupId(null);
  };
  const moveGroupTo = (groupId, axis, value) => {
    const members = draft.layers.filter((layer) => layer.groupId === groupId);
    if (!members.length || members.some((layer) => layer.locked)) return;
    const min = Math.min(...members.map((layer) => layer[axis]));
    const max = Math.max(...members.map((layer) => layer[axis] + (axis === 'x' ? layer.width : layer.height)));
    const limit = axis === 'x' ? draft.width : draft.height;
    const delta = clamp(Number(value) - min, -min, limit - max);
    if (!delta) return;
    updateDraft((previous) => ({ ...previous, layers: previous.layers.map((layer) => layer.groupId === groupId ? { ...layer, [axis]: layer[axis] + delta } : layer) }));
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
  const copyLayerFromMenu = (id, groupId = null) => {
    const layer = draft.layers.find((item) => item.id === id);
    if (!layer) return;
    const layers = groupId ? draft.layers.filter((item) => item.groupId === groupId) : [{ ...layer, groupId: undefined }];
    clipboardLayersRef.current = {
      layers: structuredClone(layers),
      groupMeta: groupId ? { [groupId]: structuredClone(draft.groupMeta?.[groupId] || {}) } : {}
    };
    setHasCopiedLayers(true);
    notify(layers.length > 1 ? `已复制 ${layers.length} 个组合图层` : `已复制图层“${layer.name}”`);
  };
  const mergeSelectedLayers = async () => {
    const layers = draft.layers.filter((layer) => selectedIds.includes(layer.id));
    if (layers.length < 2) return;
    if (layers.some((layer) => layer.locked)) return notify('请先解锁所选图层', 'error');
    const bounds = combinedLayerBounds(layers);
    const left = Math.floor(bounds.left); const top = Math.floor(bounds.top);
    const width = Math.max(1, Math.ceil(bounds.right) - left); const height = Math.max(1, Math.ceil(bounds.bottom) - top);
    try {
      const src = await renderTemplate({
        width,
        height,
        layers: layers.map((layer) => ({ ...structuredClone(layer), x: layer.x - left, y: layer.y - top }))
      }, {}, {}, { mime: 'image/png', transparent: true });
      const merged = { id: uid(), name: '合并图层', type: 'static', src, x: left, y: top, width, height, rotation: 0, opacity: 1, blendMode: 'source-over', aspectRatioLocked: true, visible: true, fit: 'fill' };
      updateDraft((previous) => {
        const topIndex = Math.max(...previous.layers.map((layer, index) => selectedIds.includes(layer.id) ? index : -1));
        const nextLayers = [];
        previous.layers.forEach((layer, index) => {
          if (!selectedIds.includes(layer.id)) nextLayers.push(layer);
          else if (index === topIndex) nextLayers.push(merged);
        });
        const groupIds = new Set(nextLayers.map((layer) => layer.groupId).filter(Boolean));
        const groupMeta = Object.fromEntries(Object.entries(previous.groupMeta || {}).filter(([id]) => groupIds.has(id)));
        return { ...previous, layers: nextLayers, groupMeta };
      });
      setSelectedIds([merged.id]);
      setSelectedGroupId(null);
      setLayerMenu(null);
    } catch (error) {
      notify(`合并图层失败：${error?.message || error}`, 'error');
    }
  };
  const moveLayerExtreme = (id, toFront, wholeGroup = false) => updateDraft((previous) => {
    const source = previous.layers.find((layer) => layer.id === id);
    if (!source) return previous;
    if (!wholeGroup && source.groupId) {
      if (source.locked) return previous;
      const members = previous.layers.filter((item) => item.groupId === source.groupId);
      const ids = members.map((item) => item.id);
      const layers = previous.layers.filter((item) => item.id !== id);
      const indexes = layers.map((item, index) => ids.includes(item.id) ? index : -1).filter((index) => index >= 0);
      const insertAt = toFront ? Math.max(...indexes) + 1 : Math.min(...indexes);
      layers.splice(insertAt, 0, source);
      return { ...previous, layers };
    }
    const ids = wholeGroup && source.groupId ? previous.layers.filter((item) => item.groupId === source.groupId).map((item) => item.id) : [id];
    if (ids.some((itemId) => previous.layers.find((item) => item.id === itemId)?.locked)) return previous;
    const moving = previous.layers.filter((item) => ids.includes(item.id));
    const rest = previous.layers.filter((item) => !ids.includes(item.id));
    return { ...previous, layers: toFront ? [...rest, ...moving] : [...moving, ...rest] };
  });
  const beginLayerNameEdit = (event, kind, id, value) => {
    event.preventDefault(); event.stopPropagation();
    setEditingLayerName({ kind, id, value });
  };
  const commitLayerNameEdit = () => {
    if (!editingLayerName) return;
    const value = editingLayerName.value.trim();
    if (value) {
      if (editingLayerName.kind === 'group') updateGroupMeta(editingLayerName.id, { name: value });
      else updateLayer(editingLayerName.id, { name: value });
    }
    setEditingLayerName(null);
  };
  const layerNameEditor = (kind, id, value) => editingLayerName?.kind === kind && editingLayerName.id === id
    ? <input className="layer-name-input" autoFocus value={editingLayerName.value} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setEditingLayerName((current) => ({ ...current, value: event.target.value }))} onBlur={commitLayerNameEdit} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitLayerNameEdit(); } else if (event.key === 'Escape') { event.preventDefault(); setEditingLayerName(null); } }}/>
    : <strong onDoubleClick={(event) => beginLayerNameEdit(event, kind, id, value)}>{value}</strong>;
  useEffect(() => () => layerReorderRef.current?.cleanup?.(), []);
  const bakeStaticLayerEdits = async (layer) => {
    if (layer.type !== 'static' || !layer.src || !(layer.paintSrc || layer.mosaicSrc || layer.eraseSrc)) return layer;
    const sourceImage = await loadImage(layer.src);
    const sourceScale = Math.max(1, (sourceImage.width || layer.width) / Math.max(1, layer.width), (sourceImage.height || layer.height) / Math.max(1, layer.height));
    const isolated = await renderIsolatedLayer(layer, layer.src, null, null, null, Math.min(4, sourceScale));
    const { paintSrc, mosaicSrc, eraseSrc, ...base } = layer;
    return { ...base, src: isolated.canvas.toDataURL('image/png') };
  };
  const save = async () => {
    if (!draft.name.trim()) return notify('请填写模板名称', 'error');
    if (!draft.layers.length) return notify('请至少添加一个图层', 'error');
    try {
      const layers = await Promise.all(draft.layers.map((layer) => bakeStaticLayerEdits(layer)));
      const finalDraft = { ...draft, layers, name: draft.name.trim(), updatedAt: Date.now() };
      await onSave(finalDraft);
    } catch (error) {
      notify(`保存图层修改失败：${error?.message || error}`, 'error');
      return;
    }
    await onClearDraft(draftKey).catch(() => undefined);
  };

  const renderLayerRow = (layer, child = false) => {
    const dropClass = layerDrop?.id === layer.id
      ? `drop-${layerDrop.placement}`
      : gifFrameLayerDrop?.id === layer.id
        ? `drop-${gifFrameLayerDrop.placement}` : '';
    return <div
      key={layer.id}
      data-layer-id={layer.id}
      data-parent-group-id={child ? layer.groupId : undefined}
      className={`layer-row ${child ? 'layer-child' : ''} ${selectedIds.includes(layer.id) ? 'selected' : ''} ${draggedLayerId === layer.id ? 'dragging' : ''} ${dropClass} ${layer.locked ? 'locked' : ''}`}
      onPointerDown={(event) => { if (!layer.locked && !event.target.closest('button, input')) beginLayerReorder(event, layer.id); }}
      onClick={(event) => selectLayer(layer.id, event)}
      onContextMenu={(event) => openLayerMenu(layer.id, event)}
    ><span className="layer-grip" title={layer.locked ? '图层已锁定' : '拖动排序'}><GripVertical size={15}/></span><div className={`layer-thumb ${layer.type}`}><LayerThumb layer={layer}/></div><div className="layer-copy">{layerNameEditor('layer', layer.id, layer.name)}<span>{layer.type === 'slot' ? `${shapeOf(layer) === 'circle' ? '圆形' : shapeOf(layer) === 'rounded' ? '圆角矩形' : shapeOf(layer) === 'polygon' ? '多边形' : '矩形'}照片` : layer.type === 'text' ? '文字图层' : isGifSource(layer.src) ? '固定图层 (GIF)' : '固定图层'}</span></div><IconButton label={layer.locked ? '解锁图层' : '锁定图层'} onClick={(event) => { event.stopPropagation(); updateLayer(layer.id, { locked: !layer.locked }); }}>{layer.locked ? <Lock size={15}/> : <Unlock size={15}/>}</IconButton><IconButton label={layer.visible ? '隐藏图层' : '显示图层'} onClick={(event) => { event.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }}>{layer.visible ? <Eye size={16}/> : <EyeOff size={16}/>}</IconButton></div>;
  };
  const layerListRows = [];
  const seenGroups = new Set();
  let groupNumber = 0;
  [...draft.layers].reverse().forEach((layer) => {
    if (!layer.groupId) {
      layerListRows.push(renderLayerRow(layer));
      return;
    }
    if (seenGroups.has(layer.groupId)) return;
    seenGroups.add(layer.groupId);
    groupNumber += 1;
    const members = draft.layers.filter((item) => item.groupId === layer.groupId).reverse();
    const collapsed = collapsedGroups.has(layer.groupId);
     const groupContainsSelectedLayer = collapsed && members.some((member) => selectedIds.includes(member.id));
     const groupSelected = selectedGroupIds.includes(layer.groupId) || selectedGroupId === layer.groupId || groupContainsSelectedLayer;
     const dropClass = layerDrop?.id === members[0].id
       ? `drop-${layerDrop.placement}`
       : gifFrameLayerDrop?.id === members[0].id
         ? `drop-${gifFrameLayerDrop.placement}` : '';
    const groupName = draft.groupMeta?.[layer.groupId]?.name || `图层组 ${groupNumber}`;
    layerListRows.push(<div
      key={`group-${layer.groupId}`}
      data-layer-id={members[0].id}
      data-group-id={layer.groupId}
      className={`layer-group-row ${groupSelected ? 'selected' : ''} ${draggedLayerId === members[0].id ? 'dragging' : ''} ${dropClass}`}
      onPointerDown={(event) => { if (!event.target.closest('button, input')) beginLayerReorder(event, members[0].id, layer.groupId); }}
      onClick={(event) => selectGroup(layer.groupId, event)}
      onContextMenu={(event) => openGroupMenu(layer.groupId, event)}
    ><span className="layer-grip" title="拖动整组排序"><GripVertical size={15}/></span><IconButton label={collapsed ? '展开图层组' : '收起图层组'} className="group-toggle" onClick={(event) => {
        event.stopPropagation();
        const collapsed = !collapsedGroups.has(layer.groupId);
        setCollapsedGroups((current) => { const next = new Set(current); if (collapsed) next.add(layer.groupId); else next.delete(layer.groupId); return next; });
        updateGroupMeta(layer.groupId, { collapsed });
      }}>{collapsed ? <ChevronRight size={15}/> : <ChevronDown size={15}/>}</IconButton><div className="layer-group-icon"><Layers3 size={17}/></div><div className="layer-copy">{layerNameEditor('group', layer.groupId, groupName)}<span>{members.length} 个图层</span></div></div>);
    if (!collapsed) members.forEach((member) => layerListRows.push(renderLayerRow(member, true)));
  });
  const contextLayer = layerMenu ? draft.layers.find((item) => item.id === layerMenu.id) : null;
  const contextGroupId = layerMenu?.groupId || null;
  const contextGroupLayers = contextGroupId ? draft.layers.filter((item) => item.groupId === contextGroupId) : [];
  const contextLocked = contextGroupId ? contextGroupLayers.some((item) => item.locked) : Boolean(contextLayer?.locked);
  const contextAllLocked = contextGroupId && contextGroupLayers.every((item) => item.locked);
  const selectedGroupName = selectedGroupId ? draft.groupMeta?.[selectedGroupId]?.name || `图层组 ${[...seenGroups].indexOf(selectedGroupId) + 1}` : '';
  const selectedOutsideLayers = draft.layers.filter((layer) => {
    if (!selectedIds.includes(layer.id) || !layer.visible) return false;
    const bounds = layerBounds(layer);
    return bounds.left < 0 || bounds.top < 0 || bounds.right > draft.width || bounds.bottom > draft.height;
  });

  const imageBounds = combinedLayerBounds(draft.layers.filter((layer) => layer.visible !== false));
  const sizeWidth = sizeMode === 'image' ? (imageBounds?.width || 0) : draft.width;
  const sizeHeight = sizeMode === 'image' ? (imageBounds?.height || 0) : draft.height;
  const commitToolbarSize = (axis, rawValue) => {
    const value = Math.max(sizeMode === 'image' ? 1 : 0, rawValue);
    if (sizeMode !== 'image') { updateDraft((previous) => ({ ...previous, [axis]: value })); return; }
    if (!imageBounds || imageBounds.width <= 0 || imageBounds.height <= 0) return;
    const requestedScale = value / (axis === 'width' ? imageBounds.width : imageBounds.height);
    const scaleX = imageSizeLocked || axis === 'width' ? requestedScale : 1;
    const scaleY = imageSizeLocked || axis === 'height' ? requestedScale : 1;
    const visualScale = imageSizeLocked ? requestedScale : Math.sqrt(scaleX * scaleY);
    const scaledX = (number) => Math.round(number * scaleX * 1000) / 1000;
    const scaledY = (number) => Math.round(number * scaleY * 1000) / 1000;
    const scaledVisual = (number) => Math.round(number * visualScale * 1000) / 1000;
    updateDraft((previous) => ({
      ...previous,
      width: Math.max(0, scaledX(previous.width)), height: Math.max(0, scaledY(previous.height)),
      layers: previous.layers.map((layer) => {
        const next = { ...layer, x: scaledX(layer.x), y: scaledY(layer.y), width: Math.max(.001, scaledX(layer.width)), height: Math.max(.001, scaledY(layer.height)), borderWidth: scaledVisual(Number(layer.borderWidth) || 0) };
        if (layer.type !== 'text') return next;
        return { ...next, fontSize: scaledVisual(Number(layer.fontSize) || 0), strokeWidth: scaledVisual(Number(layer.strokeWidth) || 0), backgroundPadding: scaledVisual(Number(layer.backgroundPadding) || 0), shadowBlur: scaledVisual(Number(layer.shadowBlur) || 0), shadowOffsetX: scaledX(Number(layer.shadowOffsetX) || 0), shadowOffsetY: scaledY(Number(layer.shadowOffsetY) || 0), textRuns: Array.isArray(layer.textRuns) ? layer.textRuns.map((run) => ({ ...run, style: { ...run.style, ...('fontSize' in (run.style || {}) ? { fontSize: scaledVisual(Number(run.style.fontSize) || 0) } : {}), ...('strokeWidth' in (run.style || {}) ? { strokeWidth: scaledVisual(Number(run.style.strokeWidth) || 0) } : {}) } })) : layer.textRuns };
      })
    }));
  };

  const beginOutsideSelectionDrag = (event) => {
    if (activeTool !== 'select' || event.button !== 0) return false;
    const stageBounds = stageHostRef.current?.getBoundingClientRect();
    if (!stageBounds) return false;
    const outsideCanvas = event.clientX < stageBounds.left || event.clientX > stageBounds.right || event.clientY < stageBounds.top || event.clientY > stageBounds.bottom;
    if (!outsideCanvas) return false;
    const point = { x: (event.clientX - stageBounds.left) / zoom, y: (event.clientY - stageBounds.top) / zoom };
    const candidates = selectedGroupId ? selectedGroupLayers : selectedLayers;
    if (!candidates.length || candidates.some((layer) => layer.locked)) return false;
    const groupBounds = selectedGroupId ? combinedLayerBounds(candidates) : null;
    const hit = groupBounds
      ? point.x >= groupBounds.left && point.x <= groupBounds.right && point.y >= groupBounds.top && point.y <= groupBounds.bottom
      : [...candidates].reverse().some((layer) => layer.visible && pointInLayer(point.x, point.y, layer));
    if (!hit) return false;
    event.preventDefault(); event.stopPropagation();
    const ids = candidates.map((layer) => layer.id);
    const positions = Object.fromEntries(candidates.map((layer) => [layer.id, { x: layer.x, y: layer.y }]));
    const start = { x: event.clientX, y: event.clientY };
    outsideDragRef.current = { ids, positions, start };
    setOutsideDragPreview({ ids, dx: 0, dy: 0 });
    const move = (mouseEvent) => {
      const drag = outsideDragRef.current;
      if (!drag) return;
      setOutsideDragPreview({ ids: drag.ids, dx: (mouseEvent.clientX - drag.start.x) / zoom, dy: (mouseEvent.clientY - drag.start.y) / zoom });
    };
    const finish = (mouseEvent) => {
      const drag = outsideDragRef.current;
      outsideDragRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', finish);
      if (!drag) return;
      const dx = (mouseEvent.clientX - drag.start.x) / zoom;
      const dy = (mouseEvent.clientY - drag.start.y) / zoom;
      setOutsideDragPreview(null);
      updateDraft((previous) => ({
        ...previous,
        layers: previous.layers.map((layer) => drag.positions[layer.id]
          ? { ...layer, x: Math.round((drag.positions[layer.id].x + dx) * 1000) / 1000, y: Math.round((drag.positions[layer.id].y + dy) * 1000) / 1000 }
          : layer)
      }));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', finish);
    return true;
  };

  return <main className="editor-page">
    <header className="editor-topbar"><div className="editor-left"><IconButton label="返回模板库" onClick={tryBack}><ArrowLeft size={21}/></IconButton><div className="title-field"><div className="editable-template-name" title="点击编辑模板名称"><input aria-label="模板名称" style={{ width: `${Math.max(8, Math.min(52, Array.from(String(draft.name || '')).reduce((total, character) => total + (/[^\x00-\xff]/.test(character) ? 2 : 1), 0) + 2))}ch` }} value={draft.name} onChange={(e) => updateDraft({ ...draft, name: e.target.value })}/><Pencil size={13} aria-hidden="true"/></div><span>{draft.width} x {draft.height}px</span></div></div><div className="editor-actions"><IconButton label="撤销 (Ctrl+Z)" onClick={undoDraft} disabled={!canUndo}><Undo2 size={18}/></IconButton><IconButton label="重做 (Ctrl+Shift+Z)" onClick={redoDraft} disabled={!canRedo}><Redo2 size={18}/></IconButton><button className="secondary-button" onClick={tryBack}>取消</button><button className="primary-button" onClick={save}><Save size={17}/>保存模板</button></div></header>
    <div className="editor-body">
      <aside className="layers-panel" onClick={(event) => { if (event.target === event.currentTarget) clearSelection(); }} onContextMenu={openLayersBlankMenu} onDragOver={handleGifFrameLayerDragOver} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setGifFrameLayerDrop(null); }} onDrop={handleGifFrameLayerDrop}>
        <div className="panel-title"><div><span>{templateHasGif ? 'GIF' : '图层'}</span><small>{draft.layers.length}</small></div></div>
        <div className="layer-add-row">
          <div className="fixed-layer-add-wrap">
            <button onClick={() => memeInput.current?.click()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setFixedLayerMenu((open) => !open); }}><ImagePlus size={18}/><span>添加固定图层</span></button>
            {fixedLayerMenu && <div className="fixed-layer-menu" onPointerDown={(event) => event.stopPropagation()}><button onClick={() => { setFixedLayerMenu(false); gifLayerInput.current?.click(); }}><ImagePlus size={16}/><span>选择一张图片创建 GIF 图层</span></button></div>}
          </div>
          <div className="shape-picker-wrap"><button onClick={(event) => { event.stopPropagation(); setShapeMenu((open) => !open); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setShapeMenu(true); }}><Shapes size={18}/><span>添加可替换照片</span></button>{shapeMenu && <div className="shape-picker" onPointerDown={(event) => event.stopPropagation()}><button onClick={() => addEmptySlot('rect')}><Square size={17}/><span>矩形</span></button><button onClick={() => addEmptySlot('circle')}><Circle size={17}/><span>圆形</span></button><button onClick={() => addEmptySlot('rounded')}><Shapes size={17}/><span>圆角矩形</span></button><button onClick={() => addEmptySlot('polygon')}><Pentagon size={17}/><span>多边形</span></button></div>}</div>
          <div className="text-add-wrap"><button className={activeTool === 'text' ? 'active' : ''} onClick={() => { setTextOrientation('horizontal'); setTextMenu(false); setActiveTool('text'); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setTextMenu(true); }}><Type size={18}/><span>添加文字</span></button>{textMenu && <div className="text-orientation-menu" onPointerDown={(event) => event.stopPropagation()}><button className={textOrientation === 'horizontal' ? 'active' : ''} onClick={() => { setTextOrientation('horizontal'); setTextMenu(false); setActiveTool('text'); }}>横排文本</button><button className={textOrientation === 'vertical' ? 'active' : ''} onClick={() => { setTextOrientation('vertical'); setTextMenu(false); setActiveTool('text'); }}>竖排文本</button></div>}</div>
        </div>
        <label className="template-tags-field"><span>模板标签</span><input value={tagsText} onChange={(event) => { const value = event.target.value; setTagsText(value); updateDraft({ ...draft, tags: value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 10) }); }} placeholder="反应、工作、猫"/></label>
        <input ref={memeInput} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) addImage(file); }}/>
        <input ref={gifLayerInput} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) addImage(file, null, { asGif: true }); }}/>
        <div className="layers-list" onClick={(event) => { if (event.target === event.currentTarget) clearSelection(); }} onContextMenu={openLayersBlankMenu} onDragOver={handleGifFrameLayerDragOver} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setGifFrameLayerDrop(null); }} onDrop={handleGifFrameLayerDrop}>{layerListRows}</div>
        {!draft.layers.length && <div className="layers-empty" onClick={clearSelection} onContextMenu={openLayersBlankMenu}><Layers3 size={28}/><p>添加第一个图层后，画布会自动匹配图层大小。</p></div>}
      </aside>
      <section className="canvas-workspace">
        <div className="canvas-toolbar">
          <div className="canvas-size"><button type="button" className={`size-mode-button ${sizeMode === 'image' ? 'active' : ''}`} title={sizeMode === 'canvas' ? '点击切换为修改图像尺寸' : '点击切换为修改画布尺寸'} onClick={() => setSizeMode((mode) => mode === 'canvas' ? 'image' : 'canvas')}>{sizeMode === 'canvas' ? '画布' : '图像'}</button><NumericInput min={sizeMode === 'image' ? 1 : 0} max={4000} presets={SIZE_PRESETS} value={sizeWidth} disabled={sizeMode === 'image' && !imageBounds} onCommit={(width) => commitToolbarSize('width', width)}/><span>×</span><NumericInput min={sizeMode === 'image' ? 1 : 0} max={4000} presets={SIZE_PRESETS} value={sizeHeight} disabled={sizeMode === 'image' && !imageBounds} onCommit={(height) => commitToolbarSize('height', height)}/>{sizeMode === 'image' && <IconButton className={`size-lock-button ${imageSizeLocked ? 'active' : ''}`} label={imageSizeLocked ? '已锁定宽高比' : '锁定宽高比'} onClick={() => setImageSizeLocked((locked) => !locked)}><Link2 size={15}/></IconButton>}{sizeMode === 'canvas' && <button className="auto-canvas-button" onClick={autoSizeCanvas}>自动设置</button>}</div>
          <div className="zoom-control"><IconButton label="缩小" onClick={() => setZoom((current) => current - .1)}><ZoomOut size={17}/></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton label="放大" onClick={() => setZoom((current) => current + .1)}><ZoomIn size={17}/></IconButton></div>
        </div>
        {timelineGifLayer && <GifTimeline frames={gifTimeline.frames} frameIndex={gifTimeline.frameIndex} selectedIndexes={gifTimeline.selectedIndexes} playing={gifTimeline.playing} layerInsertionIndex={timelineLayerInsertionIndex} onTogglePlay={() => setGifTimeline((current) => ({ ...current, playing: !current.playing }))} onSelectFrame={selectGifFrame} onDropFrame={insertGifFrame} onDuplicateFrame={duplicateGifFrame} onDeleteFrame={deleteGifFrame} onReorderFrame={reorderGifFrame}/> }
        <div className={`canvas-scroll pan-viewport ${panning ? 'panning' : ''} tool-${activeTool}`} onWheel={zoomAtPointer} onDragOver={(event) => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); }} onDrop={dropImageOnEditor} onPointerMove={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); setToolPointer({ x: event.clientX - bounds.left, y: event.clientY - bounds.top, altKey: event.altKey }); }} onPointerLeave={() => setToolPointer(null)} onMouseDown={(event) => { if (activeTool === 'text' && event.button === 0 && !event.target.closest('.canvas-tool-dock')) { event.preventDefault(); event.stopPropagation(); const bounds = stageHostRef.current?.getBoundingClientRect(); const point = bounds ? { x: clamp((event.clientX - bounds.left) / zoom, 0, Math.max(0, draft.width)), y: clamp((event.clientY - bounds.top) / zoom, 0, Math.max(0, draft.height)) } : { x: 0, y: 0 }; addTextLayer(point, textOrientation); return; } if (beginOutsideSelectionDrag(event)) return; const blank = !event.target.closest('.stage-shadow, .canvas-tool-dock'); if (activeTool === 'select' && blank) { clearSelection(); beginPan(event); } else if (activeTool === 'marquee' && event.button === 0 && blank) { event.preventDefault(); setMarqueeStartRequest({ clientX: event.clientX, clientY: event.clientY, key: event.timeStamp }); } }}>
          <div className="canvas-tool-dock"><div className="editor-paint-tools">
            <IconButton label="选择与移动" className={activeTool === 'select' ? 'active' : ''} onClick={() => setActiveTool('select')}><MousePointer2 size={17}/></IconButton>
            <IconButton label="选框工具：拖动后右键复制或剪切图层" className={activeTool === 'marquee' ? 'active' : ''} onClick={() => setActiveTool('marquee')}><BoxSelect size={17}/></IconButton>
            <IconButton label="画笔（按住 Alt 临时取色）" className={activeTool === 'brush' ? 'active' : ''} disabled={!selected || selected.locked || selectedLayers.length !== 1} onClick={() => setActiveTool('brush')}><Pencil size={17}/></IconButton>
            <IconButton label="马赛克" className={activeTool === 'mosaic' ? 'active' : ''} disabled={!selected || selected.locked || selectedLayers.length !== 1} onClick={() => setActiveTool('mosaic')}><Grid2X2 size={17}/></IconButton>
            <IconButton label="填充当前图层" className={activeTool === 'fill' ? 'active' : ''} disabled={!selected || selected.locked || selectedLayers.length !== 1} onClick={() => setActiveTool('fill')}><PaintBucket size={17}/></IconButton>
            <div className="tool-menu-wrap eraser-tool-wrap"><IconButton label={`橡皮擦：${eraserMode === 'paint' ? '仅擦除画笔' : '擦除图层'}`} className={activeTool === 'eraser' ? 'active' : ''} disabled={!selected || selected.locked || selectedLayers.length !== 1} onClick={() => setActiveTool('eraser')} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setEraserMenu(true); }}><Eraser size={17}/></IconButton>{eraserMenu && <div className="eraser-mode-menu" onPointerDown={(event) => event.stopPropagation()}><button className={eraserMode === 'paint' ? 'active' : ''} onClick={() => { setEraserMode('paint'); setEraserMenu(false); setActiveTool('eraser'); }}>仅擦除画笔</button><button className={eraserMode === 'layer' ? 'active' : ''} onClick={() => { setEraserMode('layer'); setEraserMenu(false); setActiveTool('eraser'); }}>擦除图层</button></div>}</div>
            <IconButton label="颜色选取器（可从所有图层取色）" className={activeTool === 'picker' ? 'active' : ''} onClick={() => setActiveTool('picker')}><Pipette size={17}/></IconButton>
            <input className="paint-color" type="color" aria-label="绘画颜色" title="绘画颜色" value={paintColor} onChange={(event) => setPaintColor(event.target.value)}/>
            <label className="brush-size" title="画笔和橡皮擦大小"><NumericInput aria-label="画笔大小" min={1} max={160} presets={[1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 160]} value={brushSize} onCommit={setBrushSize}/><input type="range" min="1" max="160" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))}/></label>
          </div></div>
          <div className="canvas-scroll-surface" style={{ width: `max(100%, ${Math.max(0, draft.width * zoom) + 160}px)`, height: `max(100%, ${Math.max(0, draft.height * zoom) + 160}px)` }}><div ref={stageHostRef} className="stage-shadow" style={{ width: draft.width * zoom, height: draft.height * zoom, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)` }}>
            <EditorStage gifFrameIndex={timelineGifLayer ? gifTimeline.frameIndex + 1 : null} gifFrameLayerId={timelineGifLayer?.id || null} gifFrameSource={timelineGifLayer?.id === gifTimeline.layerId ? gifTimeline.frames[gifTimeline.frameIndex]?.dataUrl : null} template={draft} selectedIds={selectedIds} selectedGroupId={selectedGroupId} selectLayer={selectLayer} selectGroup={selectGroup} clearSelection={clearSelection} updateLayer={updateLayer} updateLayers={updateLayers} onLayerContextMenu={openLayerMenu} onGroupContextMenu={openGroupMenu} onMarqueeContextMenu={openMarqueeMenu} marqueeStartRequest={marqueeStartRequest} onPanStart={beginPan} onEditText={editTextLayer} textEditingId={textEditingId} tool={activeTool} eraserMode={eraserMode} paintColor={paintColor} brushSize={brushSize} onPaintCommit={(id, patch) => updateLayer(id, patch)} onPickColor={setPaintColor} zoom={zoom}/>
            {selectedOutsideLayers.map((layer) => { const preview = outsideDragPreview?.ids.includes(layer.id) ? outsideDragPreview : null; return <div key={`outside-outline-${layer.id}`} className="outside-layer-outline" style={{ left: (layer.x + (preview?.dx || 0)) * zoom, top: (layer.y + (preview?.dy || 0)) * zoom, width: layer.width * zoom, height: layer.height * zoom, transform: `rotate(${layer.rotation || 0}deg)` }}/>; }) }
            {textEditingId && draft.layers.find((layer) => layer.id === textEditingId && layer.type === 'text') && <RichTextOverlay
              layer={draft.layers.find((layer) => layer.id === textEditingId)}
              zoom={zoom}
              selectionRange={textSelection?.id === textEditingId ? textSelection : null}
              onChange={updateSelectedText}
              onSelectionChange={(selection) => setTextSelection({ id: textEditingId, ...selection })}
              onDone={() => { setTextEditingId(null); setTextSelection(null); }}
            />}
          </div></div>
          {toolPointer && !['select', 'marquee'].includes(activeTool) && !panning && (
            ['brush', 'mosaic', 'eraser'].includes(activeTool) && !(activeTool === 'brush' && toolPointer.altKey)
              ? <div className="tool-cursor brush-preview" style={{ left: toolPointer.x, top: toolPointer.y, width: Math.max(3, brushSize * zoom), height: Math.max(3, brushSize * zoom) }}/>
              : <div className={`tool-cursor ${activeTool === 'text' ? 'text-tool-cursor' : ''}`} style={{ left: toolPointer.x, top: toolPointer.y }}>{activeTool === 'text' ? <span aria-hidden="true">T</span> : activeTool === 'picker' || (activeTool === 'brush' && toolPointer.altKey) ? <Pipette size={19}/> : <PaintBucket size={19}/>}</div>
          )}
        </div>
      </section>
      <aside className="properties-panel"><div className="panel-title"><span>属性</span></div>{selectedGroupId && selectedGroupLayers.length ? <GroupProperties name={selectedGroupName} layers={selectedGroupLayers} onRename={(name) => updateGroupMeta(selectedGroupId, { name })} onToggleLock={() => updateGroupLayers(selectedGroupId, { locked: selectedGroupLayers.some((layer) => !layer.locked) })} onToggleVisibility={() => updateGroupLayers(selectedGroupId, { visible: !selectedGroupLayers.every((layer) => layer.visible) })} onMove={(axis, value) => moveGroupTo(selectedGroupId, axis, value)} onUngroup={ungroupSelected} onRemove={() => removeGroup(selectedGroupId)} onOrder={(direction) => moveLayer(selectedGroupLayers[0].id, direction, true)}/> : selectedLayers.length > 1 ? <MultiSelectionProperties layers={selectedLayers} grouped={Boolean(uniformlySelectedGroupId)} onGroup={groupSelected} onUngroup={ungroupSelected} onToggleLock={toggleSelectedLock} onAlign={alignSelected} onDistribute={distributeSelected}/> : selected ? <Properties layers={draft.layers} gifFrameCount={templateGifFrameCount} layer={selected} gifTimeline={selectedGifLayer?.id === gifTimeline.layerId ? gifTimeline : null} onGifFrameDelay={updateGifFrameDelay} textStyle={selected.type === 'text' ? textStyleAt(selected, Math.min(Math.max(0, String(selected.text || '').length - 1), Math.min(activeTextSelection?.start ?? 0, activeTextSelection?.end ?? 0))) : null} textSelection={activeTextSelection} onBeginTextInteraction={beginPropertyTextInteraction} onTextSelectionChange={(selection) => setPropertyTextSelection({ id: selected.id, ...selection })} updateTextStyle={applySelectedTextStyle} updateText={updateSelectedText} update={updateSelectedProperties} toggleLock={() => updateLayer(selected.id, { locked: !selected.locked })} remove={() => removeLayer(selected.id)} move={(direction) => moveLayer(selected.id, direction)}/> : <div className="property-empty"><Pencil size={26}/><p>选择一个图层后，可调整位置、尺寸和旋转。</p></div>}</aside>
    </div>
    {layerMenu && <div className="layer-context-menu" style={{ left: layerMenu.x, top: Math.max(6, layerMenu.y) }} onPointerDown={(event) => event.stopPropagation()}>
      {layerMenu.marquee ? <><button onClick={() => { copyMarqueePixels(layerMenu.marquee.ids, layerMenu.marquee.rect); setLayerMenu(null); }}><Copy size={16}/>复制选框内容</button><button className="danger" onClick={() => { cutMarqueePixels(layerMenu.marquee.ids, layerMenu.marquee.rect); setLayerMenu(null); }}><Scissors size={16}/>剪切选框内容</button></> : layerMenu.blank ? <button onClick={() => { pasteLayers(); setLayerMenu(null); }}><Clipboard size={16}/>粘贴图层</button> : <>
      <button onClick={() => { copyLayerFromMenu(layerMenu.id, contextGroupId); setLayerMenu(null); }}><Copy size={16}/>复制{contextGroupId ? '图层组' : '图层'}</button>
      {selectedIds.length > 1 && <button disabled={selectedLayers.some((layer) => layer.locked)} onClick={mergeSelectedLayers}><Layers3 size={16}/>合并图层</button>}
      {contextGroupId || contextLayer?.groupId
        ? <button onClick={() => { ungroupGroup(contextGroupId || contextLayer.groupId); setLayerMenu(null); }}><Layers3 size={16}/>取消组合</button>
        : <button disabled={selectedIds.length < 2} onClick={() => { groupSelected(); setLayerMenu(null); }}><Layers3 size={16}/>组合图层</button>}
      <button onClick={() => { if (contextGroupId) updateGroupLayers(contextGroupId, { locked: !contextAllLocked }); else updateLayer(layerMenu.id, { locked: !contextLayer?.locked }); setLayerMenu(null); }}>{contextGroupId ? (contextAllLocked ? <Unlock size={16}/> : <Lock size={16}/>) : (contextLayer?.locked ? <Unlock size={16}/> : <Lock size={16}/>)} {contextGroupId ? (contextAllLocked ? '解锁图层组' : '锁定图层组') : (contextLayer?.locked ? '解锁图层' : '锁定图层')}</button>
      <button disabled={contextLocked} onClick={() => { moveLayerExtreme(layerMenu.id, true, Boolean(contextGroupId)); setLayerMenu(null); }}><ChevronUp size={16}/>置于顶层</button>
      <button disabled={contextLocked} onClick={() => { moveLayerExtreme(layerMenu.id, false, Boolean(contextGroupId)); setLayerMenu(null); }}><ChevronDown size={16}/>置于底层</button>
      <button className="danger" disabled={contextLocked} onClick={() => { if (contextGroupId) removeGroup(contextGroupId); else removeLayer(layerMenu.id); setLayerMenu(null); }}><Trash2 size={16}/>删除{contextGroupId ? '图层组' : '图层'}</button>
      </>}
    </div>}
    {leavePrompt && <div className="leave-editor-prompt" role="alertdialog" aria-modal="true" style={{ left: leavePrompt.x, top: leavePrompt.y }} onPointerDown={(event) => event.stopPropagation()}><strong>是否保存并退出编辑器？</strong><div><button className="primary-button" onClick={async () => { setLeavePrompt(null); await save(); }}>是</button><button className="secondary-button" onClick={async () => { setLeavePrompt(null); await onClearDraft(draftKey).catch(() => undefined); onBack(); }}>否</button><button className="secondary-button" onClick={() => setLeavePrompt(null)}>取消</button></div></div>}
  </main>;
}

function LayerThumb({ layer }) {
  const image = useHtmlImage(layer.src);
  if (layer.type === 'text') return <Type size={18}/>;
  if (image) return <img src={layer.src} alt=""/>;
  return <span className={`shape-thumb ${shapeOf(layer)}`} style={layer.slotFill ? { background: layer.slotFill } : undefined}></span>;
}

function richTextSegments(layer, selectionRange) {
  const text = String(layer.text || '');
  const boundaries = new Set([0, text.length]);
  (layer.textRuns || []).forEach((run) => { boundaries.add(clamp(run.start, 0, text.length)); boundaries.add(clamp(run.end, 0, text.length)); });
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') { boundaries.add(index); boundaries.add(index + 1); }
  if (selectionRange) {
    boundaries.add(clamp(Math.min(selectionRange.start, selectionRange.end), 0, text.length));
    boundaries.add(clamp(Math.max(selectionRange.start, selectionRange.end), 0, text.length));
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const selectionStart = selectionRange ? Math.min(selectionRange.start, selectionRange.end) : -1;
  const selectionEnd = selectionRange ? Math.max(selectionRange.start, selectionRange.end) : -1;
  return points.slice(0, -1).map((start, index) => ({
    start,
    end: points[index + 1],
    text: text.slice(start, points[index + 1]),
    style: textStyleAt(layer, start),
    selected: start < selectionEnd && points[index + 1] > selectionStart
  })).filter((segment) => segment.text);
}

function readTextSelection(root) {
  const selection = window.getSelection();
  if (!root || !selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const offsetOf = (node, offset) => {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  };
  return { start: offsetOf(selection.anchorNode, selection.anchorOffset), end: offsetOf(selection.focusNode, selection.focusOffset) };
}

function restoreTextSelection(root, selectionRange) {
  if (!root || !selectionRange) return;
  const textNodes = [];
  const collect = (node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) textNodes.push(child);
      else collect(child);
    });
  };
  collect(root);
  const total = textNodes.reduce((sum, node) => sum + node.textContent.length, 0);
  const positionAt = (requested) => {
    let offset = clamp(requested, 0, total);
    for (const node of textNodes) {
      if (offset <= node.textContent.length) return { node, offset };
      offset -= node.textContent.length;
    }
    return textNodes.length ? { node: textNodes.at(-1), offset: textNodes.at(-1).textContent.length } : { node: root, offset: 0 };
  };
  const start = positionAt(Math.min(selectionRange.start, selectionRange.end));
  const end = positionAt(Math.max(selectionRange.start, selectionRange.end));
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function RichTextOverlay({ layer, zoom, selectionRange, onChange, onSelectionChange, onDone }) {
  const editorRef = useRef();
  const initializedRef = useRef(false);
  const composingRef = useRef(false);
  const skipNextInputRef = useRef(false);
  const selectionRef = useRef({ start: 0, end: String(layer.text || '').length });
  const overlayBaseSize = baseTextStyle(layer).fontSize;
  const overlayFontScale = overlayBaseSize > 0 ? resolveTextFontSize(layer) / overlayBaseSize : 1;
  const renderSignature = JSON.stringify({ text: layer.text || '', runs: layer.textRuns || [], base: baseTextStyle(layer), selectionRange, zoom, layout: { width: layer.width, height: layer.height, textOrientation: layer.textOrientation, autoFit: layer.autoFit, backgroundPadding: layer.backgroundPadding, shadowEnabled: layer.shadowEnabled, shadowColor: layer.shadowColor, shadowBlur: layer.shadowBlur, shadowOffsetX: layer.shadowOffsetX, shadowOffsetY: layer.shadowOffsetY } });
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return;
    const wasFocused = document.activeElement === editor;
    const activeSelection = wasFocused ? readTextSelection(editor) : null;
    if (activeSelection) selectionRef.current = activeSelection;
    else if (selectionRange) selectionRef.current = selectionRange;
    const spans = richTextSegments(layer, selectionRef.current).map((segment) => {
      const span = document.createElement('span');
      const fontSizePx = segment.style.fontSize * overlayFontScale * zoom;
      const lineHeight = Number(segment.style.lineHeight) || 0;
      const leadingOffset = fontSizePx * (lineHeight - 1) / 2;
      span.textContent = segment.text;
      if (segment.selected) span.className = 'rich-text-selection';
      Object.assign(span.style, {
        fontFamily: segment.style.fontFamily,
        fontSize: `${fontSizePx}px`,
        fontWeight: String(segment.style.fontStyle).includes('bold') ? '700' : '400',
        fontStyle: 'normal',
        fontSynthesis: 'style weight',
        textDecoration: segment.style.textDecoration,
        color: segment.style.fill,
        lineHeight: String(segment.style.lineHeight),
        display: 'inline-block',
        position: 'relative',
        top: `${-leadingOffset + .75}px`,
        verticalAlign: 'top',
        transform: isItalicTextStyle(segment.style) ? 'skewX(-14deg)' : 'none',
        transformOrigin: 'left bottom',
        WebkitTextStroke: segment.style.strokeWidth ? `${segment.style.strokeWidth * 2 * zoom}px ${segment.style.stroke}` : '',
        paintOrder: 'stroke fill'
      });
      if (layer.shadowEnabled) span.style.textShadow = `${Number(layer.shadowOffsetX) * zoom || 0}px ${Number(layer.shadowOffsetY) * zoom || 0}px ${Math.max(0, Number(layer.shadowBlur) || 0) * zoom}px ${layer.shadowColor || '#000000'}`;
      return span;
    });
    editor.replaceChildren(...spans);
    if (!initializedRef.current) {
      initializedRef.current = true;
      selectionRef.current = { start: 0, end: String(layer.text || '').length };
      editor.focus({ preventScroll: true });
    }
    restoreTextSelection(editor, selectionRef.current);
    onSelectionChange(selectionRef.current);
  }, [layer.id, renderSignature]);
  const recordSelection = () => {
    const selection = readTextSelection(editorRef.current);
    if (selection) {
      selectionRef.current = selection;
      onSelectionChange(selection);
    }
  };
  return <div
    ref={editorRef}
    className="rich-text-overlay"
    contentEditable
    suppressContentEditableWarning
    spellCheck={false}
    style={{
      left: layer.x * zoom,
      top: layer.y * zoom,
      width: layer.width * zoom,
      height: layer.height * zoom,
      padding: `${Math.max(0, Number(layer.backgroundPadding) || 0) * zoom}px`,
      transform: `rotate(${layer.rotation || 0}deg)`,
      opacity: layerOpacityOf(layer),
      mixBlendMode: layerCssBlendModeOf(layer),
      textAlign: layer.align || 'left',
      writingMode: layer.textOrientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
      textOrientation: layer.textOrientation === 'vertical' ? 'upright' : 'mixed',
      lineHeight: 'normal',
      background: layer.background || 'transparent'
    }}
    onInput={(event) => {
      if (skipNextInputRef.current) { skipNextInputRef.current = false; return; }
      if (composingRef.current) return;
      const selection = readTextSelection(event.currentTarget);
      if (selection) selectionRef.current = selection;
      onChange(event.currentTarget.textContent.replace(/\r/g, ''));
    }}
    onMouseUp={recordSelection}
    onKeyUp={recordSelection}
    onBlur={recordSelection}
    onFocus={recordSelection}
    onCompositionStart={() => { composingRef.current = true; }}
    onCompositionEnd={(event) => {
      composingRef.current = false;
      skipNextInputRef.current = true;
      setTimeout(() => { skipNextInputRef.current = false; }, 0);
      const selection = readTextSelection(event.currentTarget);
      if (selection) selectionRef.current = selection;
      onChange(event.currentTarget.textContent.replace(/\r/g, ''));
    }}
    onPaste={(event) => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      editorRef.current.normalize();
      selectionRef.current = readTextSelection(editorRef.current) || selectionRef.current;
      onChange(editorRef.current.textContent.replace(/\r/g, ''));
    }}
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(); return; }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const newline = document.createTextNode('\n');
      range.insertNode(newline);
      range.setStartAfter(newline);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      editorRef.current.normalize();
      const nextSelection = readTextSelection(editorRef.current);
      if (nextSelection) selectionRef.current = nextSelection;
      onChange(editorRef.current.textContent.replace(/\r/g, ''));
    }}
  />;
}

function hexToRgba(color) {
  const value = String(color || '#000000').replace('#', '');
  const expanded = value.length === 3 ? [...value].map((part) => part + part).join('') : value.padEnd(6, '0').slice(0, 6);
  return [parseInt(expanded.slice(0, 2), 16), parseInt(expanded.slice(2, 4), 16), parseInt(expanded.slice(4, 6), 16), 255];
}

function rgbaToHex([red, green, blue]) {
  return `#${[red, green, blue].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

function layerLocalPoint(layer, point) {
  const radians = -(layer.rotation || 0) * Math.PI / 180;
  const dx = point.x - layer.x; const dy = point.y - layer.y;
  return { x: dx * Math.cos(radians) - dy * Math.sin(radians), y: dx * Math.sin(radians) + dy * Math.cos(radians) };
}

function floodFillCanvas(canvas, x, y, color) {
  const width = canvas.width; const height = canvas.height;
  const startX = clamp(Math.floor(x), 0, width - 1); const startY = clamp(Math.floor(y), 0, height - 1);
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data; const replacement = hexToRgba(color);
  const startOffset = (startY * width + startX) * 4;
  const target = [data[startOffset], data[startOffset + 1], data[startOffset + 2], data[startOffset + 3]];
  if (target.every((value, index) => value === replacement[index])) return;
  if (target[3] === 0 && !data.some((value) => value !== 0)) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    return;
  }
  const matches = (offset) => target.every((value, index) => data[offset + index] === value);
  const stack = [startY * width + startX];
  while (stack.length) {
    const pixel = stack.pop();
    const currentX = pixel % width; const currentY = Math.floor(pixel / width);
    const offset = pixel * 4;
    if (!matches(offset)) continue;
    replacement.forEach((value, index) => { data[offset + index] = value; });
    if (currentX + 1 < width) stack.push(pixel + 1);
    if (currentX > 0) stack.push(pixel - 1);
    if (currentY + 1 < height) stack.push(pixel + width);
    if (currentY > 0) stack.push(pixel - width);
  }
  ctx.putImageData(image, 0, 0);
}

function EditorStage({ template, selectedIds, selectedGroupId, selectLayer, selectGroup, clearSelection, updateLayer, updateLayers, onLayerContextMenu, onGroupContextMenu, onMarqueeContextMenu, marqueeStartRequest, onPanStart, onEditText, textEditingId, tool, eraserMode, paintColor, brushSize, onPaintCommit, onPickColor, zoom, gifFrameLayerId, gifFrameSource, gifFrameIndex }) {
  const stageRef = useRef();
  const trRef = useRef();
  const nodeRefs = useRef({});
  const dragRef = useRef(null);
  const selectAfterPanRef = useRef(null);
  const paintSurfacesRef = useRef({});
  const eraseSurfacesRef = useRef({});
  const mosaicSurfacesRef = useRef({});
  const mosaicBaseRef = useRef({});
  const paintingRef = useRef(null);
  const paintPointerRef = useRef(0);
  const [paintPreview, setPaintPreview] = useState(null);
  const [guides, setGuides] = useState([]);
  const [marquee, setMarquee] = useState(null);
  const marqueeRef = useRef(null);
  const marqueeTrackingRef = useRef(null);
  const lastMarqueeStartRequestRef = useRef(null);
  const [shiftPressed, setShiftPressed] = useState(false);

  useEffect(() => {
    const nodes = tool === 'select' ? selectedIds
      .map((id) => template.layers.find((layer) => layer.id === id))
      .filter((layer) => layer && layer.id !== textEditingId && !layer.locked && layer.visible)
      .map((layer) => nodeRefs.current[layer.id])
      .filter(Boolean) : [];
    if (trRef.current) {
      trRef.current.nodes(nodes);
      trRef.current.setAttrs({
        anchorSize: 10,
        anchorStrokeWidth: 1.5,
        borderStrokeWidth: 2,
        rotateAnchorOffset: 28
      });
      trRef.current.forceUpdate();
      trRef.current.getLayer()?.batchDraw();
    }
  }, [selectedIds, template.layers, textEditingId, tool, zoom]);

  useEffect(() => {
    const updateShift = (event) => setShiftPressed(event.type === 'keydown');
    const releaseShift = () => setShiftPressed(false);
    const handleKey = (event) => { if (event.key === 'Shift') updateShift(event); };
    window.addEventListener('keydown', handleKey);
    window.addEventListener('keyup', handleKey);
    window.addEventListener('blur', releaseShift);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('keyup', handleKey);
      window.removeEventListener('blur', releaseShift);
    };
  }, []);

  useEffect(() => {
    if (tool !== 'marquee') {
      marqueeTrackingRef.current?.();
      marqueeTrackingRef.current = null;
      marqueeRef.current = null;
      setMarquee(null);
    }
    return () => {
      marqueeTrackingRef.current?.();
      marqueeTrackingRef.current = null;
    };
  }, [tool]);

  const startDrag = (layer) => {
    const requestedIds = selectedIds.includes(layer.id) ? selectedIds : [layer.id];
    const ids = requestedIds.filter((id) => {
      const item = template.layers.find((candidate) => candidate.id === id);
      return item && !item.locked;
    });
    const positions = Object.fromEntries(ids.map((id) => {
      const item = template.layers.find((candidate) => candidate.id === id);
      return [id, { x: item.x, y: item.y, cx: item.x + item.width / 2, cy: item.y + item.height / 2 }];
    }));
    const items = template.layers.filter((item) => ids.includes(item.id));
    const minX = Math.min(...items.map((item) => item.x));
    const minY = Math.min(...items.map((item) => item.y));
    const maxX = Math.max(...items.map((item) => item.x + item.width));
    const maxY = Math.max(...items.map((item) => item.y + item.height));
    trRef.current?.nodes([]);
    dragRef.current = { ids, positions, anchorId: layer.id, anchor: positions[layer.id], lastDx: 0, lastDy: 0, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
  };

  const moveDrag = (layer, event) => {
    const drag = dragRef.current;
    if (!drag?.anchor || !drag.ids.includes(layer.id)) return;
    let dx = event.target.x() - drag.anchor.cx;
    let dy = event.target.y() - drag.anchor.cy;
    if (event.evt.shiftKey) {
      const virtualLayer = { id: '__selection__', width: drag.bounds.width, height: drag.bounds.height };
      const snapped = snapLayerPosition(virtualLayer, { x: drag.bounds.x + dx, y: drag.bounds.y + dy }, template, 8 / zoom, drag.ids);
      dx = snapped.x - drag.bounds.x;
      dy = snapped.y - drag.bounds.y;
      setGuides((current) => JSON.stringify(current) === JSON.stringify(snapped.guides) ? current : snapped.guides);
    } else {
      setGuides((current) => current.length ? [] : current);
    }
    drag.lastDx = dx;
    drag.lastDy = dy;
    drag.ids.forEach((id) => {
      const node = nodeRefs.current[id];
      if (!node) return;
      if (id === layer.id && !event.evt.shiftKey) return;
      node.position({ x: drag.positions[id].cx + dx, y: drag.positions[id].cy + dy });
    });
  };

  const finishDrag = (layer, event) => {
    moveDrag(layer, event);
    const drag = dragRef.current;
    if (!drag) return;
    const patches = Object.fromEntries(drag.ids.map((id) => [id, { x: Math.round(drag.positions[id].x + drag.lastDx), y: Math.round(drag.positions[id].y + drag.lastDy) }]));
    dragRef.current = null;
    setGuides([]);
    updateLayers(patches);
  };

  const groupHitAreas = (() => {
    const groupIds = [...new Set(template.layers.map((layer) => layer.groupId).filter(Boolean))];
    return groupIds.map((groupId) => {
      const members = template.layers.filter((layer) => layer.groupId === groupId && layer.visible && isLayerVisibleAtFrame(layer, gifFrameIndex));
      const bounds = combinedLayerBounds(members);
      return bounds ? { groupId, members, bounds, locked: members.some((layer) => layer.locked) } : null;
    }).filter(Boolean);
  })();

  const startGroupDrag = (group, event) => {
    event.cancelBubble = true;
    if (selectedGroupId !== group.groupId) selectGroup(group.groupId, event.evt);
    if (group.locked) return;
    const ids = group.members.map((layer) => layer.id);
    const positions = Object.fromEntries(group.members.map((layer) => [layer.id, { x: layer.x, y: layer.y }]));
    trRef.current?.nodes([]);
    dragRef.current = { kind: 'group', groupId: group.groupId, ids, positions, lastDx: 0, lastDy: 0, bounds: group.bounds };
  };

  const moveGroupDrag = (group, event) => {
    const drag = dragRef.current;
    if (drag?.kind !== 'group' || drag.groupId !== group.groupId) return;
    let dx = event.target.x() - drag.bounds.left;
    let dy = event.target.y() - drag.bounds.top;
    if (event.evt.shiftKey) {
      const virtualLayer = { id: '__group__', width: drag.bounds.width, height: drag.bounds.height };
      const snapped = snapLayerPosition(virtualLayer, { x: drag.bounds.left + dx, y: drag.bounds.top + dy }, template, 8 / zoom, drag.ids);
      dx = snapped.x - drag.bounds.left;
      dy = snapped.y - drag.bounds.top;
      event.target.position({ x: snapped.x, y: snapped.y });
      setGuides((current) => JSON.stringify(current) === JSON.stringify(snapped.guides) ? current : snapped.guides);
    } else {
      setGuides((current) => current.length ? [] : current);
    }
    drag.lastDx = dx;
    drag.lastDy = dy;
    drag.ids.forEach((id) => {
      const member = group.members.find((layer) => layer.id === id);
      nodeRefs.current[id]?.position({ x: drag.positions[id].x + dx + (member?.width || 0) / 2, y: drag.positions[id].y + dy + (member?.height || 0) / 2 });
    });
  };

  const finishGroupDrag = (group, event) => {
    moveGroupDrag(group, event);
    const drag = dragRef.current;
    if (drag?.kind !== 'group' || drag.groupId !== group.groupId) return;
    const patches = Object.fromEntries(drag.ids.map((id) => [id, {
      x: Math.round(drag.positions[id].x + drag.lastDx),
      y: Math.round(drag.positions[id].y + drag.lastDy)
    }]));
    dragRef.current = null;
    setGuides([]);
    updateLayers(patches);
  };

  const renderGroupHitArea = (group, priority = false) => <Rect
    key={`group-hit-${priority ? 'priority-' : ''}${group.groupId}`}
    x={group.bounds.left}
    y={group.bounds.top}
    width={group.bounds.width}
    height={group.bounds.height}
    fill="rgba(0,0,0,0.001)"
    draggable={tool === 'select' && !group.locked && selectedGroupId === group.groupId}
    listening={tool === 'select'}
    onMouseDown={(event) => { if (selectedGroupId === group.groupId) startGroupDrag(group, event); else { event.cancelBubble = true; if (!selectedIds.length) { selectAfterPanRef.current = { kind: 'group', id: group.groupId, x: event.evt.clientX, y: event.evt.clientY }; onPanStart(event); } } }}
    onTouchStart={(event) => { if (selectedGroupId === group.groupId) startGroupDrag(group, event); else { event.cancelBubble = true; if (!selectedIds.length) { selectAfterPanRef.current = { kind: 'group', id: group.groupId, x: event.evt.clientX, y: event.evt.clientY }; onPanStart(event); } } }}
    onClick={(event) => { event.cancelBubble = true; const pending = selectAfterPanRef.current; selectAfterPanRef.current = null; if (pending?.kind === 'group' && pending.id === group.groupId && Math.hypot(event.evt.clientX - pending.x, event.evt.clientY - pending.y) > 4) return; selectGroup(group.groupId, event.evt); }}
    onTap={(event) => { event.cancelBubble = true; selectGroup(group.groupId, event.evt); }}
    onDblClick={handleLayerDoubleClick}
    onDblTap={handleLayerDoubleClick}
    onContextMenu={(event) => { event.cancelBubble = true; onGroupContextMenu(group.groupId, event.evt); }}
    onDragMove={(event) => moveGroupDrag(group, event)}
    onDragEnd={(event) => finishGroupDrag(group, event)}
  />;

  const finishTransform = () => {
    const patches = {};
    selectedIds.forEach((id) => {
      const layer = template.layers.find((item) => item.id === id);
      const node = nodeRefs.current[id];
      if (!node || layer?.locked) return;
      const sx = node.scaleX(); const sy = node.scaleY();
      const width = Math.max(10, Math.round(node.width() * sx)); const height = Math.max(10, Math.round(node.height() * sy));
      patches[id] = { x: Math.round(node.x() - width / 2), y: Math.round(node.y() - height / 2), width, height, rotation: Math.round(node.rotation()) };
      node.scaleX(1); node.scaleY(1);
    });
    if (Object.keys(patches).length) updateLayers(patches);
  };

  const ensurePaintSurface = async (layer, kind = 'paint') => {
    const source = kind === 'erase' ? layer.eraseSrc : kind === 'mosaic' ? layer.mosaicSrc : layer.paintSrc;
    const surfaces = kind === 'erase' ? eraseSurfacesRef : kind === 'mosaic' ? mosaicSurfacesRef : paintSurfacesRef;
    const key = `${source || ''}|${Math.round(layer.width)}x${Math.round(layer.height)}`;
    const cached = surfaces.current[layer.id];
    if (cached?.key === key) return cached.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(layer.width));
    canvas.height = Math.max(1, Math.round(layer.height));
    if (source) {
      const image = await loadImage(source);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    }
    surfaces.current[layer.id] = { key, canvas };
    return canvas;
  };

  const ensureMosaicBase = async (layer) => {
    const key = JSON.stringify(layer);
    if (mosaicBaseRef.current.key === key) return mosaicBaseRef.current.canvas;
    const isolated = await renderIsolatedLayer(layer, layer.src, null, null, null);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(layer.width));
    canvas.height = Math.max(1, Math.round(layer.height));
    canvas.getContext('2d').drawImage(isolated.canvas, -isolated.insets.left, -isolated.insets.top, isolated.logicalWidth, isolated.logicalHeight);
    mosaicBaseRef.current = { key, canvas };
    return canvas;
  };

  const drawPaintSegment = (painting, point) => {
    const ctx = painting.canvas.getContext('2d');
    const scaleX = painting.canvas.width / painting.layer.width;
    const scaleY = painting.canvas.height / painting.layer.height;
    ctx.save();
    ctx.globalCompositeOperation = painting.mode === 'erase-paint' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = painting.mode === 'erase-layer' ? '#000000' : paintColor;
    ctx.lineWidth = Math.max(1, brushSize * (scaleX + scaleY) / 2);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(painting.last.x * scaleX, painting.last.y * scaleY);
    ctx.lineTo(point.x * scaleX, point.y * scaleY);
    ctx.stroke();
    ctx.restore();
    painting.last = point;
  };

  const drawMosaicSegment = (painting, point) => {
    const ctx = painting.canvas.getContext('2d');
    const base = painting.baseCanvas;
    const pixels = painting.basePixels;
    const scaleX = painting.canvas.width / painting.layer.width;
    const scaleY = painting.canvas.height / painting.layer.height;
    const radius = Math.max(6, brushSize) * (scaleX + scaleY) / 2;
    const block = Math.max(4, Math.round(brushSize * .55 * (scaleX + scaleY) / 2));
    const distance = Math.hypot(point.x - painting.last.x, point.y - painting.last.y) * Math.max(scaleX, scaleY);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, block / 2)));
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      const x = painting.last.x + (point.x - painting.last.x) * ratio;
      const y = painting.last.y + (point.y - painting.last.y) * ratio;
      for (let offsetY = -radius; offsetY <= radius; offsetY += block) {
        for (let offsetX = -radius; offsetX <= radius; offsetX += block) {
          const px = clamp(Math.floor((x + offsetX / scaleX) * scaleX), 0, base.width - 1);
          const py = clamp(Math.floor((y + offsetY / scaleY) * scaleY), 0, base.height - 1);
          const pixel = (py * base.width + px) * 4;
          ctx.fillStyle = `rgba(${pixels[pixel]},${pixels[pixel + 1]},${pixels[pixel + 2]},${pixels[pixel + 3] / 255})`;
          ctx.fillRect((x + offsetX / scaleX) * scaleX, (y + offsetY / scaleY) * scaleY, block, block);
        }
      }
    }
    painting.last = point;
  };

  const beginMarquee = (event) => {
    if (event.evt.button !== 0) return;
    event.evt.preventDefault();
    const container = stageRef.current?.container();
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const pointAt = (clientX, clientY) => ({ x: (clientX - bounds.left) / zoom, y: (clientY - bounds.top) / zoom });
    const point = pointAt(event.evt.clientX, event.evt.clientY);
    marqueeRef.current = { start: point, current: point };
    setMarquee({ x: point.x, y: point.y, width: 0, height: 0 });
    const update = (mouseEvent) => {
      const drag = marqueeRef.current;
      if (!drag) return;
      const current = pointAt(mouseEvent.clientX, mouseEvent.clientY);
      drag.current = current;
      setMarquee({ x: Math.min(drag.start.x, current.x), y: Math.min(drag.start.y, current.y), width: Math.abs(current.x - drag.start.x), height: Math.abs(current.y - drag.start.y) });
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', update);
      window.removeEventListener('mouseup', finish);
      if (marqueeTrackingRef.current === cleanup) marqueeTrackingRef.current = null;
    };
    const finish = (mouseEvent) => {
      update(mouseEvent);
      const drag = marqueeRef.current;
      marqueeRef.current = null;
      cleanup();
      if (!drag) return;
      const rect = { x: Math.min(drag.start.x, drag.current.x), y: Math.min(drag.start.y, drag.current.y), width: Math.abs(drag.current.x - drag.start.x), height: Math.abs(drag.current.y - drag.start.y) };
      setMarquee(rect.width < 2 || rect.height < 2 ? null : rect);
    };
    marqueeTrackingRef.current?.();
    marqueeTrackingRef.current = cleanup;
    window.addEventListener('mousemove', update);
    window.addEventListener('mouseup', finish);
  };

  useEffect(() => {
    if (tool !== 'marquee' || !marqueeStartRequest || lastMarqueeStartRequestRef.current === marqueeStartRequest) return;
    lastMarqueeStartRequestRef.current = marqueeStartRequest;
    beginMarquee({ evt: { button: 0, clientX: marqueeStartRequest.clientX, clientY: marqueeStartRequest.clientY, preventDefault() {} } });
  }, [marqueeStartRequest, tool]);

  const marqueeIds = () => {
    if (!marquee || marquee.width < 2 || marquee.height < 2) return [];
    const right = marquee.x + marquee.width; const bottom = marquee.y + marquee.height;
    const intersecting = template.layers.filter((layer) => {
      if (!layer.visible) return false;
      const bounds = layerBounds(layer);
      return bounds.right > marquee.x && bounds.bottom > marquee.y && bounds.left < right && bounds.top < bottom;
    }).map((layer) => layer.id);
    return selectedIds.length ? selectedIds.filter((id) => intersecting.includes(id)) : intersecting;
  };

  const openMarqueeContextMenu = (event) => {
    const nativeEvent = event.evt || event.nativeEvent || event;
    nativeEvent.preventDefault();
    nativeEvent.stopPropagation();
    const ids = marqueeIds();
    if (ids.length) onMarqueeContextMenu(ids, marquee, nativeEvent);
  };

  const beginPaint = async (event) => {
    if (!['brush', 'mosaic', 'fill', 'eraser', 'picker'].includes(tool)) return false;
    event.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    const effectiveTool = tool === 'brush' && event.evt.altKey ? 'picker' : tool;
    if (!pointer) return true;
    const templatePoint = { x: pointer.x / zoom, y: pointer.y / zoom };
    if (effectiveTool === 'picker') {
      const image = await loadImage(await renderTemplate(template, {}));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, template.width); canvas.height = Math.max(1, template.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const pixel = ctx.getImageData(clamp(Math.floor(templatePoint.x), 0, canvas.width - 1), clamp(Math.floor(templatePoint.y), 0, canvas.height - 1), 1, 1).data;
      onPickColor(rgbaToHex(pixel));
      return true;
    }
    const layer = selectedIds.length === 1 ? template.layers.find((item) => item.id === selectedIds[0] && item.visible && !item.locked) : null;
    if (!layer) return true;
    if (!pointInLayer(templatePoint.x, templatePoint.y, layer)) return true;
    const local = layerLocalPoint(layer, templatePoint);
    const pointerToken = ++paintPointerRef.current;
    const mode = effectiveTool === 'eraser' ? (eraserMode === 'layer' ? 'erase-layer' : 'erase-paint') : effectiveTool;
    const surfaceKind = mode === 'erase-layer' ? 'erase' : 'paint';
    if (effectiveTool === 'mosaic') {
      const canvas = await ensurePaintSurface(layer, 'mosaic');
      const baseCanvas = await ensureMosaicBase(layer);
      if (pointerToken !== paintPointerRef.current) return true;
      const basePixels = baseCanvas.getContext('2d').getImageData(0, 0, baseCanvas.width, baseCanvas.height).data;
      const painting = { layer, canvas, baseCanvas, basePixels, mode: 'mosaic', surfaceKind: 'mosaic', last: local };
      paintingRef.current = painting;
      drawMosaicSegment(painting, { x: local.x + .01, y: local.y + .01 });
      setPaintPreview({ id: layer.id, canvas, kind: 'mosaic', revision: 1 });
      return true;
    }
    const canvas = await ensurePaintSurface(layer, surfaceKind);
    if (pointerToken !== paintPointerRef.current) return true;
    if (effectiveTool === 'fill') {
      floodFillCanvas(canvas, local.x * canvas.width / layer.width, local.y * canvas.height / layer.height, paintColor);
      const paintSrc = canvas.toDataURL('image/png');
      paintSurfacesRef.current[layer.id] = { key: `${paintSrc}|${Math.round(layer.width)}x${Math.round(layer.height)}`, canvas };
      onPaintCommit(layer.id, { paintSrc });
      return true;
    }
    const painting = { layer, canvas, mode, surfaceKind, last: local };
    paintingRef.current = painting;
    drawPaintSegment(painting, { x: local.x + .01, y: local.y + .01 });
    setPaintPreview({ id: layer.id, canvas, kind: surfaceKind, revision: 1 });
    return true;
  };

  const movePaint = (event) => {
    const painting = paintingRef.current;
    const pointer = stageRef.current?.getPointerPosition();
    if (!painting || !pointer) return;
    const local = layerLocalPoint(painting.layer, { x: pointer.x / zoom, y: pointer.y / zoom });
    const point = { x: clamp(local.x, 0, painting.layer.width), y: clamp(local.y, 0, painting.layer.height) };
    if (painting.mode === 'mosaic') drawMosaicSegment(painting, point);
    else drawPaintSegment(painting, point);
    setPaintPreview((current) => ({ id: painting.layer.id, canvas: painting.canvas, kind: painting.surfaceKind, revision: (current?.revision || 0) + 1 }));
  };

  const finishPaint = () => {
    paintPointerRef.current += 1;
    const painting = paintingRef.current;
    if (!painting) return;
    paintingRef.current = null;
    const source = painting.canvas.toDataURL('image/png');
    const surfaces = painting.surfaceKind === 'erase' ? eraseSurfacesRef : painting.surfaceKind === 'mosaic' ? mosaicSurfacesRef : paintSurfacesRef;
    surfaces.current[painting.layer.id] = { key: `${source}|${Math.round(painting.layer.width)}x${Math.round(painting.layer.height)}`, canvas: painting.canvas };
    onPaintCommit(painting.layer.id, painting.surfaceKind === 'erase' ? { eraseSrc: source } : painting.surfaceKind === 'mosaic' ? { mosaicSrc: source } : { paintSrc: source });
    setPaintPreview(null);
  };

  useEffect(() => {
    const finishOutsideStage = () => finishPaint();
    window.addEventListener('mouseup', finishOutsideStage);
    return () => window.removeEventListener('mouseup', finishOutsideStage);
  });

  const selectedPolygon = tool === 'select' && selectedIds.length === 1
    ? template.layers.find((layer) => layer.id === selectedIds[0] && layer.type === 'slot' && shapeOf(layer) === 'polygon' && !layer.locked)
    : null;

  const handleLayerDoubleClick = (event) => {
    if (tool !== 'select') return;
    const stage = event.target?.getStage?.() || stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!pointer) return;
    event.cancelBubble = true;
    const point = { x: pointer.x / zoom, y: pointer.y / zoom };
    const target = [...template.layers].reverse().find((layer) => (
      layer.visible !== false
      && isLayerVisibleAtFrame(layer, gifFrameIndex)
      && pointInLayer(point.x, point.y, layer)
    ));
    if (!target) return;
    selectLayer(target.id, {});
    if (target.type === 'text' && !target.locked) onEditText(target.id);
  };

  return <><Stage ref={stageRef} width={template.width * zoom} height={template.height * zoom} scaleX={zoom} scaleY={zoom}
    onWheel={(event) => event.target.stopDrag?.()}
    onDblClick={handleLayerDoubleClick}
    onDblTap={handleLayerDoubleClick}
    onMouseDown={(event) => {
      if (tool === 'marquee') { beginMarquee(event); return; }
      if (tool === 'text') return;
      if (tool !== 'select') { beginPaint(event); return; }
      trRef.current?.rotationSnaps(event.evt.shiftKey || shiftPressed ? ROTATION_SNAPS : []);
      if (event.target === event.target.getStage() || event.target.name() === 'editor-background') { clearSelection(); onPanStart(event); }
    }}
    onMouseMove={['brush', 'mosaic', 'fill', 'eraser', 'picker'].includes(tool) ? movePaint : undefined}
    onMouseUp={['brush', 'mosaic', 'fill', 'eraser', 'picker'].includes(tool) ? finishPaint : undefined}
    onContextMenu={(event) => { if (tool === 'marquee') openMarqueeContextMenu(event); }}
  >
    <Layer>
      <Rect name="editor-background" width={template.width} height={template.height} fill="#fff"/>
      {groupHitAreas.filter((group) => group.groupId !== selectedGroupId).map((group) => renderGroupHitArea(group))}
      {template.layers.map((layer) => {
        if (layer.id === textEditingId || !isLayerVisibleAtFrame(layer, gifFrameIndex)) return null;
        const interactive = tool === 'select' && !layer.locked && !selectedGroupId && selectedIds.includes(layer.id);
        const selectable = tool === 'select';
        return <EditorLayer key={layer.id} layer={layer} source={layer.id === gifFrameLayerId ? gifFrameSource : undefined} interactive={interactive} selectable={selectable}
          paintSource={paintPreview?.id === layer.id && paintPreview.kind === 'paint' ? paintPreview.canvas : null}
          eraseSource={paintPreview?.id === layer.id && paintPreview.kind === 'erase' ? paintPreview.canvas : null}
          mosaicSource={paintPreview?.id === layer.id && paintPreview.kind === 'mosaic' ? paintPreview.canvas : null}
          paintRevision={paintPreview?.id === layer.id ? paintPreview.revision : 0}
          setRef={(node) => nodeRefs.current[layer.id] = node}
          onPointerDown={(event) => { if (!selectedIds.length) { selectAfterPanRef.current = { kind: 'layer', id: layer.id, x: event.evt.clientX, y: event.evt.clientY }; onPanStart(event); return; } if (!selectedIds.includes(layer.id) && !event.evt.ctrlKey && !event.evt.metaKey && !event.evt.shiftKey) selectLayer(layer.id, event.evt); }}
          onSelect={(event) => { const pending = selectAfterPanRef.current; selectAfterPanRef.current = null; if (pending?.kind === 'layer' && pending.id === layer.id && Math.hypot(event.evt.clientX - pending.x, event.evt.clientY - pending.y) > 4) return; selectLayer(layer.id, event.evt); }}
          onEnterCrop={handleLayerDoubleClick}
          onContextMenu={(event) => onLayerContextMenu(layer.id, event.evt)}
          onChange={(patch) => updateLayer(layer.id, patch)}
          onDragStart={() => startDrag(layer)} onDragMove={(event) => moveDrag(layer, event)} onDragEnd={(event) => finishDrag(layer, event)} onTransformEnd={false}/>;
      })}
      {groupHitAreas.filter((group) => group.groupId === selectedGroupId).map((group) => renderGroupHitArea(group, true))}
      {tool === 'select' && !selectedGroupId && selectedIds.map((id) => template.layers.find((layer) => layer.id === id)).filter((layer) => layer && !layer.locked && layer.visible && layer.id !== textEditingId && isLayerVisibleAtFrame(layer, gifFrameIndex)).map((layer) => <Rect key={`selected-hit-${layer.id}`} x={layer.x + layer.width / 2} y={layer.y + layer.height / 2} offsetX={layer.width / 2} offsetY={layer.height / 2} width={layer.width} height={layer.height} rotation={layer.rotation || 0} fill="rgba(0,0,0,0.001)" draggable listening onMouseDown={(event) => { event.cancelBubble = true; startDrag(layer); }} onTouchStart={(event) => { event.cancelBubble = true; startDrag(layer); }} onClick={(event) => { event.cancelBubble = true; selectLayer(layer.id, event.evt); }} onTap={(event) => { event.cancelBubble = true; selectLayer(layer.id, event.evt); }} onContextMenu={(event) => { event.cancelBubble = true; onLayerContextMenu(layer.id, event.evt); }} onDblClick={handleLayerDoubleClick} onDblTap={handleLayerDoubleClick} onDragStart={() => startDrag(layer)} onDragMove={(event) => moveDrag(layer, event)} onDragEnd={(event) => finishDrag(layer, event)}/>) }{template.layers.filter((layer) => layer.locked && selectedIds.includes(layer.id) && layer.visible).map((layer) => <Rect key={`locked-${layer.id}`} x={layer.x} y={layer.y} width={layer.width} height={layer.height} rotation={layer.rotation || 0} stroke="#e24b35" strokeWidth={2 / zoom} dash={[7 / zoom, 5 / zoom]} listening={false}/>)}
      {tool === 'marquee' && template.layers.filter((layer) => selectedIds.includes(layer.id) && layer.visible).map((layer) => <Rect key={`marquee-selected-${layer.id}`} x={layer.x} y={layer.y} width={layer.width} height={layer.height} rotation={layer.rotation || 0} stroke="#e24b35" strokeWidth={2 / zoom} dash={[7 / zoom, 5 / zoom]} listening={false}/>)}
      {guides.map((guide, index) => <Line key={`${guide.axis}-${guide.value}-${index}`} points={guide.axis === 'x' ? [guide.value, 0, guide.value, template.height] : [0, guide.value, template.width, guide.value]} stroke="#e94b37" strokeWidth={1.5 / zoom} dash={[6 / zoom, 4 / zoom]} listening={false}/>) }
      <Transformer ref={trRef} onTransformEnd={finishTransform} rotateEnabled rotationSnaps={shiftPressed ? ROTATION_SNAPS : []} rotationSnapTolerance={22.5} keepRatio={selectedIds.length === 1 && aspectRatioLockedOf(template.layers.find((item) => item.id === selectedIds[0]))} enabledAnchors={selectedIds.length === 1 && aspectRatioLockedOf(template.layers.find((item) => item.id === selectedIds[0])) ? ['top-left','top-right','bottom-left','bottom-right'] : ['top-left','top-right','bottom-left','bottom-right','middle-left','middle-right','top-center','bottom-center']} borderStroke="#e24b35" anchorFill="#fff" anchorStroke="#e24b35" anchorSize={10} anchorStrokeWidth={1.5} borderStrokeWidth={2} rotateAnchorOffset={28} boundBoxFunc={(oldBox, newBox) => (newBox.width < 24 || newBox.height < 24) ? oldBox : newBox}/>
      {selectedPolygon && <Group x={selectedPolygon.x} y={selectedPolygon.y} rotation={selectedPolygon.rotation || 0}>{polygonPointsOf(selectedPolygon).map((point, index) => <KonvaCircle key={`polygon-handle-${selectedPolygon.id}-${index}`} x={point.x * selectedPolygon.width} y={point.y * selectedPolygon.height} radius={6 / zoom} fill="#fff" stroke="#e24b35" strokeWidth={1.5 / zoom} draggable onMouseDown={(event) => { event.cancelBubble = true; }} onDragMove={(event) => { event.cancelBubble = true; event.target.position({ x: clamp(event.target.x(), 0, selectedPolygon.width), y: clamp(event.target.y(), 0, selectedPolygon.height) }); }} onDragEnd={(event) => { event.cancelBubble = true; const next = { x: clamp(event.target.x() / selectedPolygon.width, 0, 1), y: clamp(event.target.y() / selectedPolygon.height, 0, 1) }; updateLayer(selectedPolygon.id, { polygonPoints: polygonPointsOf(selectedPolygon).map((item, itemIndex) => itemIndex === index ? next : item) }); }} />)}</Group>}
    </Layer>
  </Stage>{tool === 'marquee' && marquee && <div className="marquee-selection-overlay" style={{ left: marquee.x * zoom, top: marquee.y * zoom, width: marquee.width * zoom, height: marquee.height * zoom }} onMouseDown={(event) => beginMarquee({ evt: event.nativeEvent })} onContextMenu={openMarqueeContextMenu}/>}</>;
}

function useMaskedLayerCanvas(layer, source, photoTransform, paintSource, eraseSource, mosaicSource, revision) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!layer.eraseSrc && !eraseSource) { setResult(null); return; }
    let alive = true;
    (async () => {
      const output = await renderIsolatedLayer(layer, source, photoTransform, paintSource, eraseSource, 1, mosaicSource);
      if (alive) setResult(output);
    })().catch(() => { if (alive) setResult(null); });
    return () => { alive = false; };
  }, [layer, source, photoTransform, paintSource, eraseSource, mosaicSource, revision]);
  return result;
}

function LayerBorderShape({ layer }) {
  const borderWidth = Math.min(borderWidthOf(layer), Math.max(0, Math.min(layer.width, layer.height)));
  if (!borderWidth) return null;
  const multiCount = Math.max(0, Number(layer.multiPhotoCount) || 0);
  if (layer.type === 'slot' && multiPhotoLayoutOf(layer) !== 'none' && multiCount > 1) {
    return <>{multiPhotoCells(layer, multiCount).map((cell, index) => <Group key={`${layer.id}-border-${index}`} x={cell.x} y={cell.y}><LayerBorderShape layer={{ ...layer, width: cell.width, height: cell.height, multiPhotoCount: 1, multiPhotoCellWidth: undefined, multiPhotoCellHeight: undefined }}/></Group>)}</>;
  }
  const inset = borderWidth / 2;
  const props = { stroke: layer.borderColor || '#000000', strokeWidth: borderWidth, lineJoin: 'round', listening: false };
  if (layer.type !== 'slot') return <Rect x={inset} y={inset} width={Math.max(0, layer.width - borderWidth)} height={Math.max(0, layer.height - borderWidth)} {...props}/>;
  if (shapeOf(layer) === 'circle') return <Ellipse x={layer.width / 2} y={layer.height / 2} radiusX={Math.max(0, (layer.width - borderWidth) / 2)} radiusY={Math.max(0, (layer.height - borderWidth) / 2)} {...props}/>;
  if (shapeOf(layer) === 'polygon') {
    const points = polygonPointsOf(layer).flatMap((point) => [inset + point.x * Math.max(0, layer.width - borderWidth), inset + point.y * Math.max(0, layer.height - borderWidth)]);
    return <Line points={points} closed {...props}/>;
  }
  return <Rect x={inset} y={inset} width={Math.max(0, layer.width - borderWidth)} height={Math.max(0, layer.height - borderWidth)} cornerRadius={shapeOf(layer) === 'rounded' ? Math.max(0, cornerRadiusOf(layer) - inset) : 0} {...props}/>;
}

function EditorLayer({ layer, setRef, onPointerDown, onSelect, onContextMenu, onChange, onDragStart, onDragMove, onDragEnd, onTransformEnd, interactive = true, selectable = interactive, selected = false, source, sources, paintSource, eraseSource, mosaicSource, paintRevision = 0, highlight = false, cropMode = false, photoTransform, onEnterCrop, onPhotoTransform, onPhotoTransformMove, onPhotoTransformEnd }) {
  const image = useHtmlImage(layer.type === 'slot' && layer.slotFill ? '' : (source ?? layer.src));
  const multiImages = useHtmlImages(sources || EMPTY_IMAGE_SOURCES);
  const loadedPaintImage = useHtmlImage(layer.paintSrc);
  const loadedMosaicImage = useHtmlImage(layer.mosaicSrc);
  const paintImage = paintSource || loadedPaintImage;
  const mosaicImage = mosaicSource || loadedMosaicImage;
  const maskedResult = useMaskedLayerCanvas(layer, source, photoTransform, paintSource, eraseSource, mosaicImage, paintRevision);
  const crop = image && layer.fit === 'cover' ? getCoverCrop(image, layer.width, layer.height) : undefined;
  const placement = image && layer.type === 'slot' && source ? getPhotoPlacement(image, layer, photoTransform) : null;
  if (!layer.visible) return null;
  const common = { ref: setRef, x: layer.x + layer.width / 2, y: layer.y + layer.height / 2, offsetX: layer.width / 2, offsetY: layer.height / 2, width: layer.width, height: layer.height, rotation: layer.rotation || 0, opacity: layerOpacityOf(layer), globalCompositeOperation: layerBlendModeOf(layer), draggable: interactive, listening: selectable };
  if (selectable) Object.assign(common, { onMouseDown: onPointerDown, onTouchStart: onPointerDown, onClick: onSelect, onTap: onSelect, onDblClick: onEnterCrop, onDblTap: onEnterCrop, onContextMenu });
  if (interactive) {
    Object.assign(common, { onDragStart, onDragMove, onDragEnd: onDragEnd || ((event) => onChange({ x: Math.round(event.target.x() - layer.width / 2), y: Math.round(event.target.y() - layer.height / 2) })) });
    if (onTransformEnd !== false) common.onTransformEnd = onTransformEnd || ((event) => { const node = event.target; const sx = node.scaleX(), sy = node.scaleY(); const width = Math.max(10, Math.round(node.width() * sx)); const height = Math.max(10, Math.round(node.height() * sy)); node.scaleX(1); node.scaleY(1); onChange({ x: Math.round(node.x() - width / 2), y: Math.round(node.y() - height / 2), width, height, rotation: Math.round(node.rotation()) }); });
  }
  if (maskedResult && !cropMode) return <Group {...common}><KonvaImage image={maskedResult.canvas} x={-maskedResult.insets.left} y={-maskedResult.insets.top} width={maskedResult.logicalWidth} height={maskedResult.logicalHeight}/><LayerBorderShape layer={layer}/></Group>;
  if (layer.type === 'text') {
    return <Group {...common}>
      <Rect width={layer.width} height={layer.height} fill={layer.background || 'rgba(0,0,0,.001)'}/>
      {layoutStyledText(layer).map((run, index) => <KonvaText key={`${run.x}-${run.y}-${index}`} x={run.x + (isItalicTextStyle(run.style) ? run.style.fontSize * TEXT_ITALIC_SHEAR : 0)} y={run.y} skewX={isItalicTextStyle(run.style) ? -TEXT_ITALIC_SHEAR : 0} text={run.text} fontSize={run.style.fontSize} fontFamily={run.style.fontFamily} fontStyle={renderedTextFontStyle(run.style)} textDecoration={run.style.textDecoration} fill={run.style.fill} stroke={run.style.strokeWidth > 0 ? run.style.stroke : undefined} strokeWidth={run.style.strokeWidth * 2} fillAfterStrokeEnabled lineJoin="round" shadowEnabled={Boolean(layer.shadowEnabled)} shadowColor={layer.shadowColor || '#000000'} shadowBlur={Number(layer.shadowBlur) || 0} shadowOffsetX={Number(layer.shadowOffsetX) || 0} shadowOffsetY={Number(layer.shadowOffsetY) || 0}/>) }
      {paintImage && <KonvaImage image={paintImage} width={layer.width} height={layer.height} listening={false}/>}
      {mosaicImage && <KonvaImage image={mosaicImage} width={layer.width} height={layer.height} listening={false}/>}
       <LayerBorderShape layer={layer}/>
    </Group>;
  }
  const clipFunc = (ctx) => traceLayerShape(ctx, layer);
  const disabledReplacement = layer.type === 'slot' && layer.replacementDisabled;
  const colorFilled = layer.type === 'slot' && Boolean(layer.slotFill);
  const placeholderProps = { fill: layer.slotFill || (disabledReplacement ? 'rgba(0,0,0,0)' : highlight ? 'rgba(233,78,55,.14)' : '#eceae4'), stroke: disabledReplacement ? undefined : highlight ? '#e94e37' : layer.slotFill ? undefined : '#77746d', strokeWidth: disabledReplacement ? 0 : highlight ? 5 : 2, dash: selected || disabledReplacement || (layer.slotFill && !highlight) ? undefined : [12, 8] };
  const multiLayoutActive = layer.type === 'slot' && multiPhotoLayoutOf(layer) !== 'none' && multiImages.length > 1;
  const multiCells = multiLayoutActive ? multiPhotoCells(layer, multiImages.length) : [];
  return <Group {...common} clipFunc={layer.type === 'slot' ? clipFunc : undefined}>
    {multiLayoutActive ? multiImages.map((multiImage, index) => { const cell = multiCells[index]; const cropCell = layer.fit === 'cover' ? getCoverCrop(multiImage, cell.width, cell.height) : null; return <KonvaImage key={`${layer.id}-multi-${index}`} image={multiImage} x={cell.x} y={cell.y} width={cell.width} height={cell.height} crop={cropCell || undefined} listening={false}/>; }) : image ? <KonvaImage image={image} x={placement?.x || 0} y={placement?.y || 0} width={placement?.width || layer.width} height={placement?.height || layer.height} crop={placement ? undefined : crop} draggable={cropMode} onDragMove={cropMode && placement ? (event) => { const x = clamp(event.target.x(), layer.width - placement.width, 0); const y = clamp(event.target.y(), layer.height - placement.height, 0); onPhotoTransformMove ? onPhotoTransformMove({ event, x, y, placement }) : event.target.position({ x, y }); } : undefined} onDragEnd={cropMode && placement ? (event) => { const x = clamp(event.target.x(), layer.width - placement.width, 0); const y = clamp(event.target.y(), layer.height - placement.height, 0); event.target.position({ x, y }); if (onPhotoTransformEnd) onPhotoTransformEnd({ event, x, y, placement }); else onPhotoTransform?.({ offsetX: x - placement.centeredX, offsetY: y - placement.centeredY }); } : undefined}/> : shapeOf(layer) === 'circle' ? <Ellipse x={layer.width / 2} y={layer.height / 2} radiusX={layer.width / 2} radiusY={layer.height / 2} {...placeholderProps}/> : shapeOf(layer) === 'polygon' ? <Line points={polygonPixelPoints(layer)} closed {...placeholderProps}/> : <Rect width={layer.width} height={layer.height} cornerRadius={shapeOf(layer) === 'rounded' ? cornerRadiusOf(layer) : 0} {...placeholderProps}/>} 
    {paintImage && <KonvaImage image={paintImage} width={layer.width} height={layer.height} listening={false}/>}
    {mosaicImage && <KonvaImage image={mosaicImage} width={layer.width} height={layer.height} listening={false}/>}
    {cropMode && <Rect x={1} y={1} width={Math.max(0, layer.width - 2)} height={Math.max(0, layer.height - 2)} stroke="#e94e37" strokeWidth={3} dash={[10, 7]} listening={false}/>}
    <LayerBorderShape layer={layer}/>
  </Group>;
}

const DEFAULT_NUMBER_PRESETS = [-1000, -500, -100, -50, 0, 1, 2, 4, 8, 10, 16, 24, 32, 45, 50, 64, 90, 100, 128, 180, 256, 360, 500, 512, 1000, 1024, 2000, 2048, 4000];
const SIZE_PRESETS = [0, 16, 32, 64, 128, 256, 512, 800, 1024, 1920, 2048, 3840, 4000];
const FONT_SIZE_PRESETS = [6, 8, 9, 10, 11, 12, 14, 16, 18, 24, 30, 36, 48, 60, 72];
const ROTATION_PRESETS = [-180, -135, -90, -45, 0, 45, 90, 135, 180];
const LINE_HEIGHT_PRESETS = [0.8, 1, 1.2, 1.25, 1.5, 2, 3];
const EFFECT_SIZE_PRESETS = [0, 1, 2, 4, 8, 12, 16, 24, 30, 50];
const OPACITY_PRESETS = [0, 25, 50, 75, 100];

function NumericInput({ value, onCommit, min, max, step = 1, integer = true, className = '', presets, menuActions = [], disabled = false, ...props }) {
  const [draftValue, setDraftValue] = useState(() => String(value ?? ''));
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef(null);
  const focusedRef = useRef(false);
  const cancelRef = useRef(false);
  useEffect(() => { if (!focusedRef.current) setDraftValue(String(value ?? '')); }, [value]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event) => { if (!rootRef.current?.contains(event.target)) setMenuOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  const normalize = (raw) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    let next = integer ? Math.round(parsed) : parsed;
    if (Number.isFinite(min)) next = Math.max(min, next);
    if (Number.isFinite(max)) next = Math.min(max, next);
    return next;
  };
  const commit = () => {
    focusedRef.current = false;
    if (cancelRef.current) { cancelRef.current = false; setDraftValue(String(value ?? '')); return; }
    const next = normalize(draftValue);
    if (next === null) { setDraftValue(String(value ?? '')); return; }
    setDraftValue(String(next));
    if (next !== Number(value)) onCommit(next);
  };
  const showPresets = presets !== false;
  const showMenu = showPresets || menuActions.length > 0;
  const presetValues = [...new Set((showPresets ? (presets || DEFAULT_NUMBER_PRESETS) : []).map(Number))].filter((item) => Number.isFinite(item) && (!Number.isFinite(min) || item >= min) && (!Number.isFinite(max) || item <= max));
  return <div ref={rootRef} className={`numeric-input ${showMenu ? '' : 'no-presets'} ${className}`.trim()}>
    <input {...props} disabled={disabled} type="text" inputMode={integer ? 'numeric' : 'decimal'} value={draftValue} onFocus={() => { focusedRef.current = true; cancelRef.current = false; }} onChange={(event) => setDraftValue(event.target.value)} onBlur={commit} onKeyDown={(event) => {
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRef.current = true; setMenuOpen(false); setDraftValue(String(value ?? '')); event.currentTarget.blur(); }
      if (event.key === 'ArrowDown' && event.altKey) { event.preventDefault(); setMenuOpen((open) => !open); }
    }}/>
    {showMenu && <button type="button" disabled={disabled} className="numeric-preset-toggle" title="更多选项" aria-label="更多选项" aria-expanded={menuOpen} onPointerDown={(event) => event.preventDefault()} onClick={() => setMenuOpen((open) => !open)}><ChevronDown size={14}/></button>}
    {showMenu && menuOpen && <div className="numeric-preset-menu">{presetValues.map((preset) => <button type="button" key={preset} className={Number(value) === preset ? 'active' : ''} onPointerDown={(event) => event.preventDefault()} onClick={() => { const next = normalize(preset); setMenuOpen(false); setDraftValue(String(next)); if (next !== Number(value)) onCommit(next); }}>{preset}</button>)}{menuActions.map((action) => <button type="button" key={action.label} className="numeric-menu-action" onPointerDown={(event) => event.preventDefault()} onClick={() => { setMenuOpen(false); action.onSelect?.(); }}>{action.label}</button>)}</div>}
  </div>;
}

function NumberField({ label, value, onChange, suffix, min, max, step, integer, presets, menuActions }) { return <div className="number-field"><span>{label}</span><div className="number-field-control"><NumericInput value={value} onCommit={onChange} min={min} max={max} step={step} integer={integer} presets={presets} menuActions={menuActions}/>{suffix && <em>{suffix}</em>}</div></div>; }
function GroupProperties({ name, layers, onRename, onToggleLock, onToggleVisibility, onMove, onUngroup, onRemove, onOrder }) {
  const allLocked = layers.every((layer) => layer.locked);
  const hasLocked = layers.some((layer) => layer.locked);
  const allVisible = layers.every((layer) => layer.visible);
  const left = Math.min(...layers.map((layer) => layer.x));
  const top = Math.min(...layers.map((layer) => layer.y));
  const right = Math.max(...layers.map((layer) => layer.x + layer.width));
  const bottom = Math.max(...layers.map((layer) => layer.y + layer.height));
  return <div className="property-content group-properties">
    <button className={`layer-lock-button ${allLocked ? 'active' : ''}`} onClick={onToggleLock}>{allLocked ? <Lock size={16}/> : <Unlock size={16}/>}<span>{allLocked ? '图层组已锁定' : '锁定图层组'}</span></button>
    <label className="text-field"><span>图层组名称</span><input value={name} onChange={(event) => onRename(event.target.value)}/></label>
    <div className="multi-selection-summary"><Layers3 size={24}/><strong>{layers.length} 个图层</strong><span>{Math.round(right - left)} × {Math.round(bottom - top)} px</span></div>
    <div className="property-section"><h4>位置</h4><div className="property-grid"><NumberField label="X" value={left} presets={false} onChange={(x) => { if (!hasLocked) onMove('x', x); }}/><NumberField label="Y" value={top} presets={false} onChange={(y) => { if (!hasLocked) onMove('y', y); }}/></div>{hasLocked && <p className="property-note">组内含锁定图层，解锁后才能修改整组位置。</p>}</div>
    <div className="property-section"><h4>可见性</h4><button className="wide-property-button" onClick={onToggleVisibility}>{allVisible ? <EyeOff size={16}/> : <Eye size={16}/>} {allVisible ? '隐藏图层组' : '显示图层组'}</button></div>
    <div className="property-section"><h4>图层组顺序</h4><div className="order-buttons"><button disabled={hasLocked} onClick={() => onOrder(1)}><ChevronUp size={17}/>上移</button><button disabled={hasLocked} onClick={() => onOrder(-1)}><ChevronDown size={17}/>下移</button></div></div>
    <div className="property-section"><h4>组合</h4><button className="wide-property-button" onClick={onUngroup}><Layers3 size={16}/>取消组合</button></div>
    <button className="delete-button" disabled={hasLocked} onClick={onRemove}><Trash2 size={17}/>删除图层组</button>
  </div>;
}

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

function Properties({ layer, layers = [], gifFrameCount = 0, gifTimeline, onGifFrameDelay, textStyle, textSelection, onBeginTextInteraction, onTextSelectionChange, updateTextStyle, updateText, update, toggleLock, remove, move }) {
  const [frameMenuOpen, setFrameMenuOpen] = useState(false);
  const [bindingMenuOpen, setBindingMenuOpen] = useState(false);
  const [blendMenuOpen, setBlendMenuOpen] = useState(false);
  const frameMenuRef = useRef(null);
  const bindingMenuRef = useRef(null);
  const blendMenuRef = useRef(null);
  const rotationShiftRef = useRef(false);
  const visibleFrameValues = parseFrameList(layer.visibleFrames);
  useEffect(() => { setFrameMenuOpen(false); setBindingMenuOpen(false); setBlendMenuOpen(false); }, [layer.id]);
  useEffect(() => {
    const updateShift = (event) => { if (event.key === 'Shift') rotationShiftRef.current = event.type === 'keydown'; };
    const releaseShift = () => { rotationShiftRef.current = false; };
    window.addEventListener('keydown', updateShift);
    window.addEventListener('keyup', updateShift);
    window.addEventListener('blur', releaseShift);
    return () => {
      window.removeEventListener('keydown', updateShift);
      window.removeEventListener('keyup', updateShift);
      window.removeEventListener('blur', releaseShift);
    };
  }, []);
  useEffect(() => {
    if (!frameMenuOpen) return undefined;
    const close = (event) => { if (!frameMenuRef.current?.contains(event.target)) setFrameMenuOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [frameMenuOpen]);
  useEffect(() => {
    if (!bindingMenuOpen) return undefined;
    const close = (event) => { if (!bindingMenuRef.current?.contains(event.target)) setBindingMenuOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [bindingMenuOpen]);
  useEffect(() => {
    if (!blendMenuOpen) return undefined;
    const close = (event) => { if (!blendMenuRef.current?.contains(event.target)) setBlendMenuOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [blendMenuOpen]);
  const toggleVisibleFrame = (frame) => {
    const next = visibleFrameValues.includes(frame) ? visibleFrameValues.filter((item) => item !== frame) : [...visibleFrameValues, frame];
    update({ visibleFrames: [...new Set(next)].sort((a, b) => a - b).join(',') });
  };
  const disabledReplacement = layer.type === 'slot' && layer.replacementDisabled;
  const colorFilled = layer.type === 'slot' && Boolean(layer.slotFill);
  const bindingConfigured = layer.type === 'slot' && Boolean(layer.boundLayerId);
  const bindingActive = bindingConfigured && !colorFilled;
  const bindingCandidates = layers.filter((candidate) => candidate.type === 'slot' && candidate.id !== layer.id && !candidate.boundLayerId && !candidate.replacementDisabled && !candidate.slotFill);
  const boundLayerName = bindingCandidates.find((candidate) => candidate.id === layer.boundLayerId)?.name || layers.find((candidate) => candidate.id === layer.boundLayerId)?.name || '不绑定';
  const activeBlendMode = LAYER_BLEND_MODES.find((option) => option.value === layerBlendModeOf(layer)) || LAYER_BLEND_MODES[0];
  const activeTextStyle = textStyle || baseTextStyle(layer);
  const fontTokenSet = new Set(String(activeTextStyle.fontStyle || '').split(/\s+/).filter((token) => token && token !== 'normal'));
  const decorationTokenSet = new Set(String(activeTextStyle.textDecoration || '').split(/\s+/).filter(Boolean));
  const toggleFont = (token) => {
    const next = new Set(fontTokenSet);
    if (next.has(token)) next.delete(token); else next.add(token);
    updateTextStyle({ fontStyle: ['italic', 'bold'].filter((item) => next.has(item)).join(' ') || 'normal' });
  };
  const toggleDecoration = (token) => {
    const next = new Set(decorationTokenSet);
    if (next.has(token)) next.delete(token); else next.add(token);
    updateTextStyle({ textDecoration: ['underline', 'line-through'].filter((item) => next.has(item)).join(' ') });
  };
  const updateDimension = (axis, rawValue) => {
    const value = Math.max(10, rawValue);
    if (!aspectRatioLockedOf(layer)) { update({ [axis]: value }); return; }
    const width = Math.max(0.0001, Number(layer.width) || 0.0001);
    const height = Math.max(0.0001, Number(layer.height) || 0.0001);
    if (axis === 'width') update({ width: value, height: Math.max(10, Math.round(value * height / width)) });
    else update({ height: value, width: Math.max(10, Math.round(value * width / height)) });
  };

  return <div className="property-content">
    <button className={`layer-lock-button ${layer.locked ? 'active' : ''}`} onClick={toggleLock}>{layer.locked ? <Lock size={16}/> : <Unlock size={16}/>}<span>{layer.locked ? '图层已锁定' : '锁定图层'}</span></button>
    <label className="text-field"><span>图层名称</span><input value={layer.name} onChange={(event) => update({ name: event.target.value })}/></label>

    {isGifSource(layer.src) && gifTimeline?.frames?.length ? <div className="property-section"><h4>GIF 帧设置</h4><div className="gif-frame-property"><img src={gifTimeline.frames[gifTimeline.frameIndex]?.dataUrl} alt="当前 GIF 帧"/><div><strong>第 {gifTimeline.frameIndex + 1} 帧{gifTimeline.selectedIndexes?.length > 1 ? ` · 已选 ${gifTimeline.selectedIndexes.length} 帧` : ''}</strong><NumberField label="播放时间" suffix="ms" value={Math.max(20, Number(gifTimeline.frames[gifTimeline.frameIndex]?.delayMs) || 100)} min={20} max={60000} presets={false} menuActions={[{ label: '应用到所有帧', onSelect: () => onGifFrameDelay?.(gifTimeline.frameIndex, Math.max(20, Number(gifTimeline.frames[gifTimeline.frameIndex]?.delayMs) || 100), true) }]} onChange={(value) => onGifFrameDelay?.(gifTimeline.frameIndex, value)}/></div></div></div> : null}
    {gifFrameCount > 0 && !isGifSource(layer.src) ? <div className="property-section"><h4>出现帧</h4><div ref={frameMenuRef} className="frame-visibility-control"><input value={layer.visibleFrames || ''} placeholder="留空表示所有帧均显示" onChange={(event) => update({ visibleFrames: event.target.value })}/><button type="button" title="选择帧" onClick={() => setFrameMenuOpen((open) => !open)}>+</button>{frameMenuOpen && <div className="frame-visibility-menu">{Array.from({ length: gifFrameCount }, (_, index) => index + 1).map((frame) => <button type="button" key={frame} className={visibleFrameValues.includes(frame) ? 'active' : ''} onClick={() => toggleVisibleFrame(frame)}>{frame}</button>)}</div>}</div></div> : null}
    {layer.type === 'text' && <>
      <div className="property-section text-content-section"><h4>文字内容</h4><textarea value={layer.text || ''} onPointerDown={onBeginTextInteraction} onFocus={onBeginTextInteraction} onChange={(event) => { onBeginTextInteraction?.(); updateText(event.target.value); onTextSelectionChange?.({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }); }} onSelect={(event) => onTextSelectionChange?.({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}/><label className="check-row text-lock-row"><input type="checkbox" checked={Boolean(layer.textLocked)} onChange={(event) => update({ textLocked: event.target.checked })}/><span>锁定文本</span></label></div>
      <div className="property-section"><h4>字体{textSelection && textSelection.start !== textSelection.end ? ' · 已选 ' + Math.abs(textSelection.end - textSelection.start) + ' 字' : ''}</h4><select className="property-select" value={activeTextStyle.fontFamily} onChange={(event) => updateTextStyle({ fontFamily: event.target.value })}><option value="Microsoft YaHei">微软雅黑</option><option value="SimHei">黑体</option><option value="SimSun">宋体</option><option value="KaiTi">楷体</option><option value="Arial">Arial</option><option value="Segoe UI">Segoe UI</option></select><div className="text-format-row"><div><span>字号</span><NumericInput min={TEXT_SIZE_MIN} max={TEXT_SIZE_MAX} presets={FONT_SIZE_PRESETS} value={activeTextStyle.fontSize} onCommit={(fontSize) => updateTextStyle({ fontSize })}/></div><input className="color-swatch" type="color" title="文字颜色" value={activeTextStyle.fill} onChange={(event) => updateTextStyle({ fill: event.target.value })}/></div><NumberField label="间距" value={activeTextStyle.lineHeight} min={0} max={20} step={0.05} integer={false} presets={LINE_HEIGHT_PRESETS} onChange={(lineHeight) => updateTextStyle({ lineHeight })}/><label className="check-row" title="内容超出文本框时自动缩小字号；关闭后保持设定字号，超出部分可能被裁切。"><input type="checkbox" checked={Boolean(layer.autoFit)} onChange={(event) => update({ autoFit: event.target.checked })}/><span>文字自动适配文本框</span></label><div className="format-buttons"><button type="button" title="加粗" className={fontTokenSet.has('bold') ? 'active' : ''} onPointerDown={(event) => event.preventDefault()} onClick={() => toggleFont('bold')}><Bold size={17}/></button><button type="button" title="斜体" className={fontTokenSet.has('italic') ? 'active' : ''} onPointerDown={(event) => event.preventDefault()} onClick={() => toggleFont('italic')}><Italic size={17}/></button><button type="button" title="下划线" className={decorationTokenSet.has('underline') ? 'active' : ''} onPointerDown={(event) => event.preventDefault()} onClick={() => toggleDecoration('underline')}><Underline size={17}/></button><button type="button" title="删除线" className={decorationTokenSet.has('line-through') ? 'active' : ''} onPointerDown={(event) => event.preventDefault()} onClick={() => toggleDecoration('line-through')}><Strikethrough size={17}/></button></div><div className="format-buttons align-buttons"><button title="左对齐" className={layer.align === 'left' ? 'active' : ''} onClick={() => update({ align: 'left' })}><AlignLeft size={17}/></button><button title="居中" className={layer.align === 'center' ? 'active' : ''} onClick={() => update({ align: 'center' })}><AlignCenter size={17}/></button><button title="右对齐" className={layer.align === 'right' ? 'active' : ''} onClick={() => update({ align: 'right' })}><AlignRight size={17}/></button></div></div>
      <div className="property-section"><h4>文字效果</h4><div className="effect-grid"><label><span>外描边</span><input type="color" value={activeTextStyle.stroke} onChange={(event) => updateTextStyle({ stroke: event.target.value })}/></label><NumberField label="外描边宽度" value={activeTextStyle.strokeWidth} min={0} max={30} presets={EFFECT_SIZE_PRESETS} onChange={(strokeWidth) => updateTextStyle({ strokeWidth })}/><label><span>背景</span><input type="color" value={layer.background || '#ffffff'} onChange={(event) => update({ background: event.target.value })}/></label><NumberField label="背景内边距" value={layer.backgroundPadding || 0} min={0} max={100} presets={EFFECT_SIZE_PRESETS} onChange={(backgroundPadding) => update({ backgroundPadding })}/></div><button className="wide-property-button subtle" onClick={() => update({ background: layer.background ? '' : '#ffffff' })}>{layer.background ? '移除文字背景' : '启用文字背景'}</button><label className="check-row"><input type="checkbox" checked={Boolean(layer.shadowEnabled)} onChange={(event) => update({ shadowEnabled: event.target.checked })}/><span>启用文字阴影</span></label>{layer.shadowEnabled && <div className="effect-grid"><label><span>阴影颜色</span><input type="color" value={layer.shadowColor || '#000000'} onChange={(event) => update({ shadowColor: event.target.value })}/></label><NumberField label="模糊" value={layer.shadowBlur || 0} min={0} max={50} presets={EFFECT_SIZE_PRESETS} onChange={(shadowBlur) => update({ shadowBlur })}/><NumberField label="水平偏移" value={layer.shadowOffsetX || 0} onChange={(shadowOffsetX) => update({ shadowOffsetX })}/><NumberField label="垂直偏移" value={layer.shadowOffsetY || 0} onChange={(shadowOffsetY) => update({ shadowOffsetY })}/></div>}</div>
    </>}
    <div className="property-section layer-composite-section">
      <div className="blend-mode-row"><h4>图层混合模式</h4><div ref={blendMenuRef} className="property-dropdown blend-mode-field"><button type="button" className="property-dropdown-trigger" aria-expanded={blendMenuOpen} onClick={() => { setBlendMenuOpen((open) => !open); setBindingMenuOpen(false); setFrameMenuOpen(false); }}><span>{activeBlendMode.label}</span><ChevronDown size={14}/></button>{blendMenuOpen && <div className="property-dropdown-menu blend-mode-menu">{LAYER_BLEND_MODES.map((option) => <button type="button" key={option.value} className={activeBlendMode.value === option.value ? 'active' : ''} onClick={() => { update({ blendMode: option.value }); setBlendMenuOpen(false); }}><span>{option.label}</span></button>)}</div>}</div></div>
    </div>
    <div className="property-section"><h4>位置</h4><div className="property-grid"><NumberField label="X" value={layer.x} presets={false} onChange={(x) => update({ x })}/><NumberField label="Y" value={layer.y} presets={false} onChange={(y) => update({ y })}/></div><div className="rotation-inline-row"><div className="rotation-inline-control"><h4>旋转</h4><div className="rotation-inline-input"><NumericInput value={Number(layer.rotation) || 0} min={-360} max={360} presets={ROTATION_PRESETS} onCommit={(rotation) => update({ rotation })}/></div></div><input className="range" type="range" min="-180" max="180" value={Number(layer.rotation) || 0} onChange={(event) => { const rotation = Number(event.target.value); update({ rotation: rotationShiftRef.current ? Math.round(rotation / 45) * 45 : rotation }); }}/></div></div>
    <div className="property-section"><div className="property-heading-row"><h4>尺寸</h4><button type="button" className={`aspect-lock-button ${aspectRatioLockedOf(layer) ? 'active' : ''}`} title={aspectRatioLockedOf(layer) ? '取消锁定宽高比' : '锁定宽高比'} onClick={() => update({ aspectRatioLocked: !aspectRatioLockedOf(layer) })}>{aspectRatioLockedOf(layer) ? <Lock size={13}/> : <Unlock size={13}/>}<span>宽高比</span></button></div><div className="property-grid"><NumberField label="宽" value={layer.width} min={10} presets={SIZE_PRESETS} onChange={(width) => updateDimension('width', width)}/><NumberField label="高" value={layer.height} min={10} presets={SIZE_PRESETS} onChange={(height) => updateDimension('height', height)}/></div></div>
    <div className="property-section"><h4>边框</h4><div className="border-controls"><label><span>颜色</span><input type="color" value={layer.borderColor || '#000000'} onChange={(event) => update({ borderColor: event.target.value })}/></label><NumberField label="大小" value={layer.borderWidth || 0} min={0} max={100} presets={EFFECT_SIZE_PRESETS} onChange={(borderWidth) => update({ borderWidth })}/></div></div>
    {layer.type === 'slot' && <>
      <div className="property-section"><h4>槽位形状</h4><div className="shape-segmented four"><button className={shapeOf(layer) === 'rect' ? 'active' : ''} onClick={() => update({ shape: 'rect' })}>矩形</button><button className={shapeOf(layer) === 'circle' ? 'active' : ''} onClick={() => update({ shape: 'circle' })}>圆形</button><button className={shapeOf(layer) === 'rounded' ? 'active' : ''} onClick={() => update({ shape: 'rounded', cornerRadius: layer.cornerRadius ?? 36 })}>圆角</button><button className={shapeOf(layer) === 'polygon' ? 'active' : ''} onClick={() => update({ shape: 'polygon', polygonSides: layer.polygonSides || 5, polygonPoints: polygonPointsOf(layer) })}>多边形</button></div>{shapeOf(layer) === 'rounded' && <div className="rounded-radius-control"><NumberField label="圆角半径" value={layer.cornerRadius ?? 36} min={0} max={Math.floor(Math.min(layer.width, layer.height) / 2)} presets={[0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128]} onChange={(cornerRadius) => update({ cornerRadius })}/></div>}{shapeOf(layer) === 'polygon' && <div className="polygon-controls"><NumberField label="边数" value={layer.polygonSides || 5} min={POLYGON_MIN_SIDES} max={POLYGON_MAX_SIDES} presets={[3, 4, 5, 6, 8, 10, 12, 16]} onChange={(polygonSides) => update({ polygonSides, polygonPoints: regularPolygonPoints(polygonSides) })}/>{polygonPointsOf(layer).map((point, index) => <label key={index} className="polygon-radius"><span>顶点 {index + 1}</span><input type="range" min="10" max="100" value={polygonRadiusPercent(point)} onChange={(event) => update({ polygonPoints: polygonPointsOf(layer).map((item, itemIndex) => itemIndex === index ? polygonPointAtRadius(item, Number(event.target.value)) : item) })}/><output>{polygonRadiusPercent(point)}%</output></label>)}</div>}</div>
      <div className="property-section slot-fill-section"><h4>照片 / 颜色填充</h4>
        <div className="slot-fill-mode" role="group" aria-label="填充类型"><button type="button" className={!colorFilled ? 'active' : ''} onClick={() => update({ slotFill: '' })}><FileImage size={15}/>照片填充</button><button type="button" className={colorFilled ? 'active' : ''} onClick={() => update({ slotFill: layer.slotFill || '#e24b35', replacementDisabled: false })}><PaintBucket size={15}/>颜色填充</button></div>
        <div className={`slot-photo-options ${!colorFilled ? 'active' : 'disabled'}`}><label className="check-row replacement-disable-row" title="禁用后，使用模板时不再要求添加照片；槽位保持透明，但颜色填充和边框仍会显示。"><input type="checkbox" disabled={colorFilled} checked={Boolean(layer.replacementDisabled)} onChange={(event) => update({ replacementDisabled: event.target.checked })}/><span>禁用替换照片</span></label><div className="slot-option-heading"><strong>照片适配</strong>{colorFilled && <small>颜色填充已启用</small>}</div><div className="segmented"><button disabled={disabledReplacement || colorFilled || bindingActive} className={layer.fit === 'cover' ? 'active' : ''} onClick={() => update({ fit: 'cover' })}>裁切铺满</button><button disabled={disabledReplacement || colorFilled || bindingActive} className={layer.fit === 'fill' ? 'active' : ''} onClick={() => update({ fit: 'fill' })}>拉伸填满</button></div><div className={`slot-inline-field multi-photo-layout-field ${disabledReplacement || colorFilled || bindingActive ? 'disabled' : ''}`}><strong>多图排列</strong><select className="property-select" disabled={disabledReplacement || colorFilled || bindingActive} value={multiPhotoLayoutOf(layer)} onChange={(event) => update({ multiPhotoLayout: event.target.value })}><option value="none">无</option><option value="horizontal">横向排列</option><option value="vertical">纵向排列</option><option value="grid">网格换行</option></select></div>{multiPhotoLayoutOf(layer) === 'grid' && <label className={`multi-photo-columns ${disabledReplacement || colorFilled || bindingActive ? 'disabled' : ''}`}><strong>每行最多</strong><NumericInput disabled={disabledReplacement || colorFilled || bindingActive} min={1} max={12} presets={[1,2,3,4,5,6,7,8,9,10,11,12]} value={Number(layer.multiPhotoColumns) || 2} onCommit={(value) => update({ multiPhotoColumns: value })}/><span>张</span></label>}<div ref={bindingMenuRef} className={`property-dropdown slot-inline-field slot-binding-field ${colorFilled ? 'disabled' : ''}`}><strong>绑定图层</strong><button type="button" className="property-dropdown-trigger" disabled={colorFilled} aria-expanded={bindingMenuOpen} onClick={() => setBindingMenuOpen((open) => !open)}><span>{boundLayerName}</span><ChevronDown size={14}/></button>{bindingMenuOpen && !colorFilled && <div className="property-dropdown-menu"><button type="button" className={!layer.boundLayerId ? 'active' : ''} onClick={() => { update({ boundLayerId: undefined }); setBindingMenuOpen(false); }}>不绑定</button>{bindingCandidates.map((candidate) => <button type="button" key={candidate.id} className={layer.boundLayerId === candidate.id ? 'active' : ''} onClick={() => { update({ boundLayerId: candidate.id }); setBindingMenuOpen(false); }}>{candidate.name}</button>)}</div>}</div>{bindingActive && <p className="property-note">使用模板时跟随绑定的可替换图层，不会单独显示在可替换图层列表中。</p>}</div>
        <div className={`slot-color-options ${colorFilled ? 'active' : ''}`}><label className="slot-color-picker"><strong>填充颜色</strong><input type="color" disabled={!colorFilled} value={layer.slotFill || '#e24b35'} onChange={(event) => update({ slotFill: event.target.value, replacementDisabled: false })}/><code>{layer.slotFill || '#e24b35'}</code></label><button type="button" className={`wide-property-button ${colorFilled ? 'active' : ''}`} onClick={() => update(colorFilled ? { slotFill: '' } : { slotFill: '#e24b35', replacementDisabled: false })}>{colorFilled ? '关闭颜色填充' : '启用颜色填充'}</button></div>
      </div>    </>}

    <div className="property-section opacity-inline-row"><h4>透明度</h4><div className="opacity-inline-control"><NumericInput value={Math.round(layerOpacityOf(layer) * 100)} min={0} max={100} presets={OPACITY_PRESETS} onCommit={(opacity) => update({ opacity: clamp(opacity / 100, 0, 1) })}/></div></div>
    <div className="property-section layer-order-inline-row"><h4>图层顺序</h4><div className="order-buttons"><button disabled={layer.locked} onClick={() => move(1)}><ChevronUp size={17}/>上移</button><button disabled={layer.locked} onClick={() => move(-1)}><ChevronDown size={17}/>下移</button></div></div>
    <button className="delete-button" disabled={layer.locked} onClick={remove}><Trash2 size={17}/>删除图层</button>
  </div>;
}

function pointInLayer(x, y, layer) {
  const radians = -(layer.rotation || 0) * Math.PI / 180;
  const centerX = layer.x + layer.width / 2; const centerY = layer.y + layer.height / 2;
  const dx = x - centerX; const dy = y - centerY;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians) + layer.width / 2;
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians) + layer.height / 2;
  if (localX < 0 || localY < 0 || localX > layer.width || localY > layer.height) return false;
  if (shapeOf(layer) === 'polygon') {
    const points = polygonPointsOf(layer).map((point) => ({ x: point.x * layer.width, y: point.y * layer.height }));
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
      const currentPoint = points[index]; const previousPoint = points[previous];
      const intersects = ((currentPoint.y > localY) !== (previousPoint.y > localY))
        && (localX < (previousPoint.x - currentPoint.x) * (localY - currentPoint.y) / (previousPoint.y - currentPoint.y || 1e-9) + currentPoint.x);
      if (intersects) inside = !inside;
    }
    return inside;
  }
  if (shapeOf(layer) === 'rounded') {
    const radius = cornerRadiusOf(layer);
    if (!radius) return true;
    const centerX = localX < radius ? radius : localX > layer.width - radius ? layer.width - radius : localX;
    const centerY = localY < radius ? radius : localY > layer.height - radius ? layer.height - radius : localY;
    const dx = localX - centerX; const dy = localY - centerY;
    return dx * dx + dy * dy <= radius * radius;
  }
  if (shapeOf(layer) !== 'circle') return true;
  const nx = (localX - layer.width / 2) / (layer.width / 2);
  const ny = (localY - layer.height / 2) / (layer.height / 2);
  return nx * nx + ny * ny <= 1;
}

function UseStage({ composition, slotSources, slotSourceLists = {}, slotTransforms, selectedId, setSelectedId, updateLayer, cropModeId, setCropModeId, updatePhotoTransform, onRequestSlot, zoom, pan, panning, onPanStart, transparent, lockAspectRatio, textEditingId, textSelection, onEditText, onTextChange, onTextSelectionChange, onTextDone }) {
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
      <Stage width={composition.width * scale} height={composition.height * scale} scaleX={scale} scaleY={scale} onWheel={(event) => event.target.stopDrag?.()} onMouseDown={(event) => { if (event.target === event.target.getStage() || event.target.name() === 'result-background') { if (textEditingId) onTextDone(); setSelectedId(null); setCropModeId(null); onPanStart(event); } }}>
        <Layer>
          <Rect name="result-background" width={composition.width} height={composition.height} fill={transparent ? 'rgba(0,0,0,0)' : '#fff'}/>
          {composition.layers.map((layer) => textEditingId === layer.id ? null : <EditorLayer
            key={layer.id}
             layer={layer}
             selected={selectedId === layer.id}
             source={layer.type === 'slot' ? (slotSources[layer.id] || (layer.boundLayerId ? slotSources[layer.boundLayerId] : undefined)) : undefined}
             sources={layer.type === 'slot' ? (slotSourceLists[layer.id] || (layer.boundLayerId ? slotSourceLists[layer.boundLayerId] : undefined)) : undefined}
            photoTransform={slotTransforms[layer.id]}
            cropMode={cropModeId === layer.id}
            interactive={isReplaceableSlot(layer) && Boolean(slotSources[layer.id]) && cropModeId !== layer.id}
            selectable={isReplaceableSlot(layer) || layer.type === 'text'}
            highlight={isReplaceableSlot(layer) && !slotSources[layer.id]}
            setRef={(node) => { if (isReplaceableSlot(layer)) nodeRefs.current[layer.id] = node; }}
            onSelect={() => {
              setSelectedId(layer.id);
              setCropModeId(null);
              if (isReplaceableSlot(layer) && !slotSources[layer.id]) onRequestSlot(layer.id);
            }}
             onEnterCrop={(event) => {
               event.cancelBubble = true;
               if (layer.type === 'text') {
                 if (layer.textLocked) return;
                 onEditText(layer.id);
                 return;
               }
               if (!isReplaceableSlot(layer) || !slotSources[layer.id]) return;
               setSelectedId(layer.id);
               setCropModeId(layer.id);
             }}
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
      {textEditingId && composition.layers.find((layer) => layer.id === textEditingId && layer.type === 'text' && !layer.textLocked) && <RichTextOverlay
        layer={composition.layers.find((layer) => layer.id === textEditingId)}
        zoom={scale}
        selectionRange={textSelection?.id === textEditingId ? textSelection : null}
        onChange={onTextChange}
        onSelectionChange={(selection) => onTextSelectionChange({ id: textEditingId, ...selection })}
        onDone={onTextDone}
      />}
    </div>}
  </div>;
}

function createUseSession(template) {
  return {
    composition: structuredClone(template),
    slotSources: {},
    slotNames: {},
    slotSourceLists: {},
    slotNameLists: {},
    slotTransforms: {}
  };
}

function UseTemplate({ template, initialFiles, cachedSession, onSaveSession, onBack, onEdit, notify }) {
  const initialSessionRef = useRef();
  if (!initialSessionRef.current) {
    const canRestore = cachedSession?.templateUpdatedAt === (template.updatedAt || 0)
      && Array.isArray(cachedSession.session?.composition?.layers)
      && cachedSession.session?.slotSources
      && cachedSession.session?.slotNames
      && cachedSession.session?.slotTransforms;
    initialSessionRef.current = canRestore ? structuredClone(cachedSession.session) : createUseSession(template);
  }
  const [session, commitSession, undo, canUndo, redo, canRedo] = useUndoState(() => initialSessionRef.current);
  const { composition, slotSources, slotNames, slotTransforms } = session;
  const slotSourceLists = session.slotSourceLists || {};
  const slotNameLists = session.slotNameLists || {};
  const [result, setResult] = useState('');
  const [copied, setCopied] = useState(false);
  const {
    progress: exportProgress,
    begin: beginExport,
    update: updateExport,
    isCancelled: isExportCancelled,
    finish: finishExport,
    cancel: cancelExport
  } = useExportProgress(notify);
  const { zoom, pan, panning, setZoom, zoomAtPointer, beginPan } = useCanvasViewport(1, .5, 10);
  const [selectedId, setSelectedId] = useState(template.layers.find(isReplaceableSlot)?.id || null);
  const [textEditingId, setTextEditingId] = useState(null);
  const [textSelection, setTextSelection] = useState(null);
  const [cropModeId, setCropModeId] = useState(null);
  const [slotDropId, setSlotDropId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [slotContextMenu, setSlotContextMenu] = useState(null);
  const [slotGalleryId, setSlotGalleryId] = useState(null);
  const [topMenu, setTopMenu] = useState(false);
  const [groupRosterChoice, setGroupRosterChoice] = useState(null);
  const [groupRosterBusy, setGroupRosterBusy] = useState(false);
  const templateHasGif = template.layers.some((layer) => isGifSource(layer.src));
  const [exportFormat, setExportFormat] = useState(() => templateHasGif ? 'gif' : 'png');
  const [exportScale, setExportScale] = useState(1);
  const [transparent, setTransparent] = useState(false);
  const [lockAspectRatio, setLockAspectRatio] = useState(true);
  const input = useRef();
  const pendingSlot = useRef(null);
  const pendingAppend = useRef(false);
  const initialHandled = useRef(false);
  const renderRequest = useRef(0);
  const topMenuRef = useRef();
  const slotGalleryRef = useRef();
  const groupRosterInput = useRef();
  const slots = composition.layers.filter(isReplaceableSlot);
  const textLayers = composition.layers.filter((layer) => layer.type === 'text' && !layer.textLocked);
  const editableTextLayers = textLayers;
  const batchSlot = slots.length === 1 ? slots[0] : null;
  const batchSources = batchSlot ? (slotSourceLists[batchSlot.id] || (slotSources[batchSlot.id] ? [slotSources[batchSlot.id]] : [])) : [];
  const batchNames = batchSlot ? (slotNameLists[batchSlot.id] || (slotNames[batchSlot.id] ? [slotNames[batchSlot.id]] : [])) : [];
  const gallerySources = slotGalleryId ? (slotSourceLists[slotGalleryId] || (slotSources[slotGalleryId] ? [slotSources[slotGalleryId]] : [])) : [];
  const galleryNames = slotGalleryId ? (slotNameLists[slotGalleryId] || (slotNames[slotGalleryId] ? [slotNames[slotGalleryId]] : [])) : [];
  const renderReplacements = useMemo(() => {
    const next = { ...slotSources };
    Object.entries(slotSourceLists).forEach(([slotId, sources]) => {
      if (Array.isArray(sources) && sources.length) next[slotId] = sources;
    });
    return next;
  }, [slotSourceLists, slotSources]);
  const cropLayer = composition.layers.find((layer) => layer.id === cropModeId && layer.type === 'slot');
  const cropTransform = cropLayer ? (slotTransforms[cropLayer.id] || { zoom: 1, offsetX: 0, offsetY: 0 }) : null;
  const outputMime = exportFormat === 'jpg' ? 'image/jpeg' : `image/${exportFormat}`;
  const renderOutput = useCallback((targetTemplate, replacements = {}, transforms = {}, options = {}) => {
    const mime = options.mime || 'image/png';
    if (mime === 'image/gif') return renderAnimatedTemplate(targetTemplate, replacements, transforms, options);
    return renderTemplate(targetTemplate, replacements, transforms, options);
  }, []);
  const exportScaleHint = '控制保存和复制图片的像素尺寸；2x 的宽高均为 1x 的 2 倍。';

  const editTextLayer = useCallback((id) => {
    const layer = composition.layers.find((item) => item.id === id && item.type === 'text');
    if (!layer || layer.textLocked) return;
    setSelectedId(id);
    setCropModeId(null);
    setTextEditingId(id);
    setTextSelection({ id, start: 0, end: String(layer.text || '').length });
  }, [composition.layers]);
  const updateTextLayerById = useCallback((id, text) => {
    commitSession((previous) => ({
      ...previous,
      composition: {
        ...previous.composition,
        layers: previous.composition.layers.map((layer) => layer.id === id
          ? fitTextLayerToContent({ ...layer, ...updateTextContent(layer, text) })
          : layer)
      }
    }));
  }, [commitSession]);
  const updateTextLayer = useCallback((text) => {
    if (textEditingId) updateTextLayerById(textEditingId, text);
  }, [textEditingId, updateTextLayerById]);
  const finishTextEditing = useCallback(() => {
    setTextEditingId(null);
    setTextSelection(null);
  }, []);

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
  const persistSession = useCallback(() => Promise.resolve(onSaveSession(template.id, {
    templateUpdatedAt: template.updatedAt || 0,
    session
  })).catch(() => notify('使用记录保存失败', 'error')), [notify, onSaveSession, session, template.id, template.updatedAt]);
  const tryBack = useCallback(() => {
    persistSession();
    onBack();
  }, [onBack, persistSession]);
  const editTemplate = useCallback(() => {
    persistSession();
    onEdit();
  }, [onEdit, persistSession]);

  useEffect(() => {
    const timer = setTimeout(persistSession, 150);
    return () => clearTimeout(timer);
  }, [persistSession]);

  const replaceSlotSources = useCallback((slotId, dataUrls, names = [], append = false) => {
    const incomingSources = dataUrls.filter(Boolean);
    if (!incomingSources.length) return;
    commitSession((previous) => {
      const previousSources = append ? (previous.slotSourceLists?.[slotId] || (previous.slotSources[slotId] ? [previous.slotSources[slotId]] : [])) : [];
      const previousNames = append ? (previous.slotNameLists?.[slotId] || (previous.slotNames[slotId] ? [previous.slotNames[slotId]] : [])) : [];
      const nextSources = [...previousSources, ...incomingSources];
      const nextNames = [...previousNames, ...incomingSources.map((_, index) => names[index] || '')];
      return {
        ...previous,
        composition: resizeMultiPhotoSlot(previous.composition, template, slotId, nextSources.length),
        slotSources: { ...previous.slotSources, [slotId]: nextSources[0] },
        slotNames: { ...previous.slotNames, [slotId]: nextNames[0] || '' },
        slotSourceLists: { ...(previous.slotSourceLists || {}), [slotId]: nextSources },
        slotNameLists: { ...(previous.slotNameLists || {}), [slotId]: nextNames },
        slotTransforms: { ...previous.slotTransforms, [slotId]: append && previous.slotTransforms[slotId] ? previous.slotTransforms[slotId] : { zoom: 1, offsetX: 0, offsetY: 0 } }
      };
    });
    setSelectedId(slotId);
  }, [commitSession, template]);

  const replaceSlotSource = useCallback((slotId, dataUrl, name) => {
    replaceSlotSources(slotId, [dataUrl], [name], false);
  }, [replaceSlotSources]);

  const removeSlotSource = useCallback((slotId) => {
    commitSession((previous) => {
      if (!previous.slotSources[slotId]) return previous;
      const slotSources = { ...previous.slotSources };
      const slotNames = { ...previous.slotNames };
      const slotSourceLists = { ...(previous.slotSourceLists || {}) };
      const slotNameLists = { ...(previous.slotNameLists || {}) };
      const slotTransforms = { ...previous.slotTransforms };
      delete slotSources[slotId];
      delete slotNames[slotId];
      delete slotSourceLists[slotId];
      delete slotNameLists[slotId];
      delete slotTransforms[slotId];
      return { ...previous, composition: resizeMultiPhotoSlot(previous.composition, template, slotId, 1), slotSources, slotNames, slotSourceLists, slotNameLists, slotTransforms };
    });
    setSelectedId(slotId);
    setCropModeId((current) => current === slotId ? null : current);
    setSlotGalleryId((current) => current === slotId ? null : current);
  }, [commitSession, template]);

  const resetSlotLayer = useCallback((slotId) => {
    const originalLayer = template.layers.find((layer) => layer.id === slotId && layer.type === 'slot');
    if (!originalLayer) return;
    commitSession((previous) => {
      const slotSources = { ...previous.slotSources };
      const slotNames = { ...previous.slotNames };
      const slotSourceLists = { ...(previous.slotSourceLists || {}) };
      const slotNameLists = { ...(previous.slotNameLists || {}) };
      const slotTransforms = { ...previous.slotTransforms };
      delete slotSources[slotId];
      delete slotNames[slotId];
      delete slotSourceLists[slotId];
      delete slotNameLists[slotId];
      delete slotTransforms[slotId];
      return {
        ...previous,
        composition: {
          ...previous.composition,
          layers: previous.composition.layers.map((layer) => layer.id === slotId ? structuredClone(originalLayer) : layer)
        },
        slotSources,
        slotNames,
        slotSourceLists,
        slotNameLists,
        slotTransforms
      };
    });
    setSelectedId(slotId);
    setCropModeId((current) => current === slotId ? null : current);
    setSlotGalleryId((current) => current === slotId ? null : current);
  }, [commitSession, template.layers]);

  const removeSlotSourceAt = useCallback((slotId, index) => {
    commitSession((previous) => {
      const currentSources = previous.slotSourceLists?.[slotId] || (previous.slotSources[slotId] ? [previous.slotSources[slotId]] : []);
      const currentNames = previous.slotNameLists?.[slotId] || (previous.slotNames[slotId] ? [previous.slotNames[slotId]] : []);
      const nextSources = currentSources.filter((_, itemIndex) => itemIndex !== index);
      const nextNames = currentNames.filter((_, itemIndex) => itemIndex !== index);
      const next = {
        ...previous,
        composition: resizeMultiPhotoSlot(previous.composition, template, slotId, nextSources.length || 1),
        slotSources: { ...previous.slotSources },
        slotNames: { ...previous.slotNames },
        slotSourceLists: { ...(previous.slotSourceLists || {}) },
        slotNameLists: { ...(previous.slotNameLists || {}) }
      };
      if (nextSources.length) {
        next.slotSources[slotId] = nextSources[0];
        next.slotNames[slotId] = nextNames[0] || '';
        next.slotSourceLists[slotId] = nextSources;
        next.slotNameLists[slotId] = nextNames;
      } else {
        delete next.slotSources[slotId];
        delete next.slotNames[slotId];
        delete next.slotSourceLists[slotId];
        delete next.slotNameLists[slotId];
      }
      return next;
    });
  }, [commitSession, template]);

  const pasteClipboardImage = useCallback(async (targetId, append = false) => {
    const slotId = targetId || selectedId || composition.layers.find(isReplaceableSlot)?.id;
    if (!slotId) return notify('模板中没有可替换照片图层', 'error');
    try {
      const dataUrl = await desktop.readClipboardImage();
      if (!dataUrl) return notify('剪贴板中没有图片', 'error');
      if (append) replaceSlotSources(slotId, [dataUrl], ['剪贴板图片'], true);
      else replaceSlotSource(slotId, dataUrl, '剪贴板图片');
    } catch (error) {
      notify(`读取剪贴板失败：${error?.message || error}`, 'error');
    }
  }, [composition.layers, notify, replaceSlotSource, replaceSlotSources, selectedId]);

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
    if (cropModeId && !slotSources[cropModeId]) setCropModeId(null);
  }, [cropModeId, slotSources]);

  useEffect(() => {
    setCopied(false);
    // 中间画布本身会实时显示文字和图层变化。GIF 模板编辑时不在每次
    // 状态变化后自动编码全部帧，只在复制或保存时执行完整 GIF 编码。
    if (templateHasGif) {
      setResult('gif-ready');
      return undefined;
    }
    const request = ++renderRequest.current;
    let cancelled = false;
    renderOutput(composition, slotSources, slotTransforms, { scale: exportScale, transparent, mime: outputMime }).then((dataUrl) => {
      if (cancelled || request !== renderRequest.current) return;
      setResult(dataUrl);
    }).catch((error) => {
      if (!cancelled) notify(`生成失败：${error.message}`, 'error');
    });
    return () => { cancelled = true; };
  }, [composition, exportScale, outputMime, renderOutput, slotSources, slotTransforms, templateHasGif, transparent, notify]);

  const acceptFile = useCallback(async (file, targetId) => {
    try {
      const requestedLayer = composition.layers.find((layer) => layer.id === (targetId || selectedId));
      const slotId = isReplaceableSlot(requestedLayer)
        ? requestedLayer.id
        : composition.layers.find(isReplaceableSlot)?.id;
      if (!slotId) return notify('模板中没有可替换照片图层', 'error');
      const dataUrl = await fileToDataUrl(file);
      replaceSlotSource(slotId, dataUrl, file.name);
    } catch (error) { notify(error.message, 'error'); }
  }, [composition.layers, notify, replaceSlotSource, selectedId]);

  const acceptInitialFiles = useCallback(async (files, targetId = null, append = false) => {
    const incoming = Array.from(files || []).filter((file) => isImageFileLike(file));
    if (!incoming.length) return;
    const targetSlots = composition.layers.filter(isReplaceableSlot);
    if (!targetSlots.length) return;
    try {
      if (targetSlots.length === 1 || targetId) {
        const slotId = targetId || targetSlots[0].id;
        const sources = await Promise.all(incoming.map((file) => fileToDataUrl(file)));
        replaceSlotSources(slotId, sources, incoming.map((file) => file.name || ''), append);
        return;
      }
      const distributedSlots = targetSlots.slice(0, incoming.length);
      const sources = await Promise.all(distributedSlots.map((slot, index) => fileToDataUrl(incoming[index])));
      const sourceEntries = Object.fromEntries(distributedSlots.map((slot, index) => [slot.id, sources[index]]));
      const nameEntries = Object.fromEntries(distributedSlots.map((slot, index) => [slot.id, incoming[index]?.name || '']));
      const sourceListEntries = Object.fromEntries(distributedSlots.map((slot, index) => [slot.id, [sources[index]]]));
      const nameListEntries = Object.fromEntries(distributedSlots.map((slot, index) => [slot.id, [incoming[index]?.name || '']]));
      const transformEntries = Object.fromEntries(distributedSlots.map((slot) => [slot.id, { zoom: 1, offsetX: 0, offsetY: 0 }]));
      commitSession((previous) => ({
        ...previous,
        slotSources: { ...previous.slotSources, ...sourceEntries },
        slotNames: { ...previous.slotNames, ...nameEntries },
        slotSourceLists: { ...(previous.slotSourceLists || {}), ...sourceListEntries },
        slotNameLists: { ...(previous.slotNameLists || {}), ...nameListEntries },
        slotTransforms: { ...previous.slotTransforms, ...transformEntries }
      }));
      setSelectedId(distributedSlots.at(-1)?.id || null);
    } catch (error) {
      notify(`读取图片失败：${error?.message || error}`, 'error');
    }
  }, [commitSession, composition.layers, notify, replaceSlotSources]);

  const importGroupRosterRows = useCallback(async (rows, textField = 'none') => {
    if (!rows.length || groupRosterBusy) return;
    setGroupRosterChoice(null);
    setGroupRosterBusy(true);
    try {
      const downloads = await desktop.downloadGroupFaces(rows.map((row) => row.workerId));
      const imported = downloads
        .map((download, index) => ({ download, row: rows[index] }))
        .filter(({ download }) => Boolean(download?.dataUrl));

      if (imported.length) {
        if (slots.length === 1) {
          replaceSlotSources(
            slots[0].id,
            imported.map(({ download }) => download.dataUrl),
            imported.map(({ row }) => `${row.workerId}.jpg`),
            false
          );
        } else {
          const distributed = imported.slice(0, slots.length);
          commitSession((previous) => {
            const next = {
              ...previous,
              slotSources: { ...previous.slotSources },
              slotNames: { ...previous.slotNames },
              slotSourceLists: { ...(previous.slotSourceLists || {}) },
              slotNameLists: { ...(previous.slotNameLists || {}) },
              slotTransforms: { ...previous.slotTransforms }
            };
            distributed.forEach(({ download, row }, index) => {
              const slotId = slots[index].id;
              next.slotSources[slotId] = download.dataUrl;
              next.slotNames[slotId] = `${row.workerId}.jpg`;
              next.slotSourceLists[slotId] = [download.dataUrl];
              next.slotNameLists[slotId] = [`${row.workerId}.jpg`];
              next.slotTransforms[slotId] = { zoom: 1, offsetX: 0, offsetY: 0 };
            });
            return next;
          });
          setSelectedId(distributed.length ? slots[distributed.length - 1].id : null);
        }
      }

      if (textField !== 'none' && editableTextLayers.length) {
        commitSession((previous) => ({
          ...previous,
          composition: {
            ...previous.composition,
            layers: previous.composition.layers.map((layer) => {
              const textIndex = editableTextLayers.findIndex((candidate) => candidate.id === layer.id);
              if (textIndex < 0 || textIndex >= rows.length) return layer;
              return fitTextLayerToContent({
                ...layer,
                ...updateTextContent(layer, String(rows[textIndex][textField] ?? ''))
              });
            })
          }
        }));
      }

      const failed = downloads.filter((download) => !download?.dataUrl);
      if (!imported.length) {
        const detail = failed[0]?.error ? `：${failed[0].error}` : '';
        notify(`群名单中的头像均下载失败${detail}`, 'error');
      } else if (failed.length) {
        notify(`已导入 ${imported.length} 张头像，另有 ${failed.length} 张下载失败`, 'error');
      } else {
        notify(`已从群名单导入 ${imported.length} 张头像`);
      }
    } catch (error) {
      notify(`导入群名单失败：${error?.message || error}`, 'error');
    } finally {
      setGroupRosterBusy(false);
    }
  }, [commitSession, editableTextLayers, groupRosterBusy, notify, replaceSlotSources, slots]);

  const chooseGroupRosterFile = useCallback(async (file) => {
    if (!file) return;
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error('工作簿中没有可读取的工作表');
      const table = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      if (!table.length) throw new Error('表格中没有数据');
      const headers = table[0].map((value) => String(value ?? '').trim());
      const column = (name) => headers.indexOf(name);
      const workerIdColumn = column('工号');
      if (workerIdColumn < 0) throw new Error('第一行中未找到“工号”表头');
      const rows = table.slice(1).map((values) => ({
        workerId: String(values[workerIdColumn] ?? '').trim(),
        chineseName: column('中文名') >= 0 ? String(values[column('中文名')] ?? '') : '',
        englishName: column('英文名') >= 0 ? String(values[column('英文名')] ?? '') : '',
        nickname: column('昵称') >= 0 ? String(values[column('昵称')] ?? '') : ''
      })).filter((row) => row.workerId);
      if (!rows.length) throw new Error('“工号”列中没有可导入的数据');
      if (editableTextLayers.length) {
        setGroupRosterChoice({ rows, fileName: file.name });
      } else {
        await importGroupRosterRows(rows, 'none');
      }
    } catch (error) {
      notify(`读取群名单失败：${error?.message || error}`, 'error');
    }
  }, [editableTextLayers.length, importGroupRosterRows, notify]);

  const generateBatch = useCallback(async (files, targetId, append = false) => {
    const requestedLayer = composition.layers.find((layer) => layer.id === targetId);
    const slotId = isReplaceableSlot(requestedLayer) ? requestedLayer.id : slots.length === 1 ? slots[0].id : null;
    if (!slotId) return notify('多图仅支持模板只有一个可替换照片图层的情况', 'error');
    await acceptInitialFiles(files, slotId, append);
  }, [acceptInitialFiles, composition.layers, notify, slots]);

  const requestSlotImage = useCallback((slotId, append = false) => {
    const layer = composition.layers.find((item) => item.id === slotId);
    if (!isReplaceableSlot(layer)) return;
    pendingSlot.current = slotId;
    pendingAppend.current = append;
    input.current?.click();
  }, [composition.layers]);

  useEffect(() => {
    const incomingFiles = Array.isArray(initialFiles) ? initialFiles : (initialFiles ? [initialFiles] : []);
    if (!incomingFiles.length || initialHandled.current) return;
    initialHandled.current = true;
    if (incomingFiles.length > 1) {
      acceptInitialFiles(incomingFiles);
    } else {
      acceptFile(incomingFiles[0], composition.layers.find(isReplaceableSlot)?.id);
    }
  }, [acceptFile, acceptInitialFiles, composition.layers, initialFiles]);

  const currentResult = useCallback(async (job = null) => {
    const useLegacyBatchAnimation = batchSlot && multiPhotoLayoutOf(batchSlot) === 'none' && batchSources.length > 1;
    const dataUrl = outputMime === 'image/gif' && useLegacyBatchAnimation
      ? await renderAnimatedBatchTemplate(composition, batchSlot.id, batchSources, slotSources, slotTransforms, {
        scale: exportScale,
        transparent,
        mime: outputMime,
         signal: job?.controller.signal,
         onFrameProgress: job ? (value) => updateExport(job, 8 + value * 58, `正在生成 GIF（${Math.round(value * 100)}%）`) : undefined,
         onBatchProgress: job ? (value) => updateExport(job, 8 + value * 58, `正在合成 GIF（${Math.round(value * 100)}%）`) : undefined
      })
      : await renderOutput(composition, renderReplacements, slotTransforms, { scale: exportScale, transparent, mime: outputMime, signal: job?.controller.signal });
    if (job && isExportCancelled(job)) return '';
    if (job) updateExport(job, 68, '正在准备复制');
    setResult(dataUrl);
    return dataUrl;
  }, [batchSlot, batchSources, composition, exportScale, isExportCancelled, outputMime, renderOutput, renderReplacements, slotSources, slotTransforms, transparent, updateExport]);

  const copyAgain = useCallback(async () => {
    const job = beginExport(outputMime === 'image/gif' ? '正在导出 GIF' : '正在导出图片');
    updateExport(job, 5);
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    try {
      if (batchSlot && multiPhotoLayoutOf(batchSlot) === 'none' && batchSources.length > 1 && outputMime !== 'image/gif') {
        const outputs = [];
        for (let index = 0; index < batchSources.length; index += 1) {
          if (isExportCancelled(job)) return;
          outputs.push(await renderOutput(
            composition,
             { ...renderReplacements, [batchSlot.id]: batchSources[index] },
            slotTransforms,
            { scale: exportScale, transparent, mime: outputMime, signal: job.controller.signal }
          ));
          if (isExportCancelled(job)) return;
          updateExport(job, 8 + (index + 1) / batchSources.length * 70, `正在生成第 ${index + 1}/${batchSources.length} 张作品`);
        }
        if (isExportCancelled(job)) return;
        updateExport(job, 88, '正在复制到剪贴板');
        await desktop.copyImages(outputs);
        if (isExportCancelled(job)) return;
        setResult(outputs[0] || 'batch-ready');
        setCopied(true);
        updateExport(job, 100, '导出完成');
        notify(`已生成并复制 ${outputs.length} 张作品`);
        return;
      }
      const dataUrl = await currentResult(job);
      if (!dataUrl || isExportCancelled(job)) return;
      const clipboardDataUrl = outputMime === 'image/png'
        ? undefined
         : await renderTemplate(composition, renderReplacements, slotTransforms, { scale: exportScale, transparent, mime: 'image/png', signal: job.controller.signal });
      if (isExportCancelled(job)) return;
      updateExport(job, 88, '正在复制到剪贴板');
      await desktop.copyImage(dataUrl, clipboardDataUrl);
      if (isExportCancelled(job)) return;
      setCopied(true);
      updateExport(job, 100, '导出完成');
      notify(outputMime === 'image/gif' && batchSources.length > 1
        ? `已将 ${batchSources.length} 张图片合成为 1 个 GIF 并复制`
        : '已复制，可粘贴到聊天窗口或文件夹');
    } catch (error) {
      if (!isExportCancelled(job)) {
        setCopied(false);
        notify(`复制失败：${error?.message || error}`, 'error');
      }
    } finally {
      finishExport(job);
    }
  }, [batchSlot, batchSources, beginExport, composition, currentResult, exportScale, finishExport, isExportCancelled, notify, outputMime, renderOutput, renderReplacements, slotSources, slotTransforms, transparent, updateExport]);

  const resetUse = useCallback(() => {
    commitSession(createUseSession(template));
    setSelectedId(null);
    setCropModeId(null);
    setSlotDropId(null);
    setSlotGalleryId(null);
    setContextMenu(null);
    setSlotContextMenu(null);
    setCopied(false);
  }, [commitSession, template]);

  useEffect(() => {
    if (!slotGalleryId) return undefined;
    const frame = requestAnimationFrame(() => slotGalleryRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [slotGalleryId]);

  useEffect(() => {
    const handleKeyDown = async (event) => {
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (commandKey && key === 'z' && !event.shiftKey) {
        event.preventDefault(); undo();
        return;
      }
      if (commandKey && ((key === 'z' && event.shiftKey) || key === 'y')) {
        event.preventDefault(); redo();
        return;
      }
      if (commandKey && key === 'v' && !event.shiftKey && !event.altKey && !isTextEditingTarget(event.target)) {
        event.preventDefault();
        if (slotGalleryId && slotGalleryRef.current?.contains(event.target)) pasteClipboardImage(slotGalleryId, true);
        else pasteClipboardImage();
        return;
      }
      if (event.key.startsWith('Arrow') && !commandKey && !event.altKey && !isTextEditingTarget(event.target)) {
        event.preventDefault(); nudgeSelectedPhoto(event.key, event.shiftKey ? 10 : 1);
        return;
      }
      if (event.key === 'Escape' && !event.repeat) {
        event.preventDefault();
        tryBack();
      }
    };
    const handleCopy = (event) => {
      if (selectedId || isTextEditingTarget(event.target)) return;
      event.preventDefault();
      copyAgain();
    };
    const closeMenu = (event) => {
      setContextMenu(null);
      setSlotContextMenu(null);
      if (!topMenuRef.current?.contains(event.target)) setTopMenu(false);
      if (!slotGalleryRef.current?.contains(event.target)) setSlotGalleryId(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('copy', handleCopy);
    window.addEventListener('pointerdown', closeMenu);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('copy', handleCopy);
      window.removeEventListener('pointerdown', closeMenu);
    };
  }, [copyAgain, nudgeSelectedPhoto, pasteClipboardImage, redo, selectedId, slotGalleryId, tryBack, undo]);

  const resetCrop = () => { if (cropModeId) updatePhotoTransform(cropModeId, { zoom: 1, offsetX: 0, offsetY: 0 }); };

  const dropOnSlot = (event) => {
    const files = Array.from(event.dataTransfer.files || []).filter((item) => isImageFileLike(item));
    const file = files[0];
    if (!file) return;
    event.preventDefault();
    const frame = event.currentTarget.querySelector('.result-canvas-frame');
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const x = (event.clientX - rect.left) * composition.width / rect.width;
    const y = (event.clientY - rect.top) * composition.height / rect.height;
    const target = [...composition.layers].reverse().find((layer) => isReplaceableSlot(layer) && layer.visible && pointInLayer(x, y, layer));
    if (!target) return notify('请把图片拖到高亮的可替换区域', 'error');
    if (files.length > 1) acceptInitialFiles(files, target.id); else acceptFile(file, target.id);
  };

  const dropOnSlotList = (event, slotId) => {
    event.preventDefault(); event.stopPropagation(); setSlotDropId(null);
    const files = Array.from(event.dataTransfer.files || []).filter((item) => isImageFileLike(item)); const file = files[0];
    if (!file) return notify('请拖入图片文件', 'error');
    if (files.length > 1) acceptInitialFiles(files, slotId); else acceptFile(file, slotId);
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
      y: Math.max(6, Math.min(event.clientY, window.innerHeight - 90))
    });
  };

  const clearSidebarSelection = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('button, input, textarea, select, label')) return;
    setSelectedId(null);
    setCropModeId(null);
  };

  return <main className="use-page">
    <header className="editor-topbar">
      <div className="editor-left"><IconButton label="返回模板库" onClick={tryBack}><ArrowLeft size={21}/></IconButton><div className="title-field"><strong>{template.name}</strong><span>使用模板</span></div></div>
      <div className="editor-actions"><IconButton label="撤销 (Ctrl+Z)" onClick={undo} disabled={!canUndo}><Undo2 size={18}/></IconButton><IconButton label="重做 (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}><Redo2 size={18}/></IconButton><button className="secondary-button" onClick={resetUse}><RotateCcw size={16}/>重置</button><div ref={topMenuRef} className="card-menu-wrap"><IconButton label="更多操作" onClick={() => setTopMenu((current) => !current)}><MoreHorizontal size={19}/></IconButton>{topMenu && <div className="context-menu"><button onClick={() => { setTopMenu(false); editTemplate(); }}><Pencil size={16}/>编辑模板</button></div>}</div></div>
    </header>
    <div className="use-layout">
      <section className="use-sidebar" onPointerDown={clearSidebarSelection}>
        <p className="eyebrow">第 1 步</p><h1>替换照片</h1><p className="use-intro">双击左侧图层、点击画布中的高亮区域、拖入图片，或按 Ctrl+V 粘贴剪贴板图片。</p>
        <div className="slot-list-heading"><strong>可替换图层</strong><span>{slots.length}</span></div>
        <div className="slot-list">
          {slots.map((layer) => {
            const source = slotSources[layer.id];
            const name = slotNames[layer.id];
            const sources = slotSourceLists[layer.id] || (source ? [source] : []);
            const extraCount = Math.max(0, sources.length - 1);
            const galleryOpen = slotGalleryId === layer.id;
            return <div key={layer.id} className={`slot-item-row ${slotDropId === layer.id ? 'dragging' : ''} ${galleryOpen ? 'gallery-open' : ''}`} onContextMenu={(event) => openSlotContextMenu(event, layer.id)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setSlotDropId(layer.id); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSlotDropId((current) => current === layer.id ? null : current); }} onDrop={(event) => dropOnSlotList(event, layer.id)}>
              <button type="button" className={`slot-item ${selectedId === layer.id ? 'selected' : ''}`} onClick={() => setSelectedId(layer.id)} onDoubleClick={() => { setSelectedId(layer.id); requestSlotImage(layer.id); }}>
                <span className={`slot-item-thumb ${source ? 'has-image' : ''}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { if (!source) return; event.stopPropagation(); setSelectedId(layer.id); setSlotGalleryId((current) => current === layer.id ? null : layer.id); }}>{source ? <><img src={source} alt=""/>{extraCount > 0 && <b className="slot-thumb-count">+{extraCount}</b>}</> : <LayerThumb layer={layer}/>}</span>
                <span className="slot-item-copy"><strong>{layer.name}</strong><small>{name || (multiPhotoLayoutLabel(layer) ? `双击选择图片（${multiPhotoLayoutLabel(layer)}）` : '双击选择照片')}</small></span>
                {source
                  ? <span className="slot-reset-control" role="button" tabIndex={0} title="重置此可替换图层" aria-label="重置此可替换图层" onClick={(event) => { event.stopPropagation(); resetSlotLayer(layer.id); }} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); resetSlotLayer(layer.id); } }}><RotateCcw size={16}/></span>
                  : <ImagePlus size={16}/>}
              </button>
              {source && <IconButton label={cropModeId === layer.id ? '退出裁切' : '裁切照片'} className={cropModeId === layer.id ? 'active slot-crop-button' : 'slot-crop-button'} onClick={() => { setSelectedId(layer.id); setCropModeId((current) => current === layer.id ? null : layer.id); }}><Crop size={16}/></IconButton>}
              {galleryOpen && <div ref={slotGalleryRef} className="slot-gallery-popover" role="dialog" tabIndex={-1} aria-label={`${layer.name} 已选择的照片`} onPointerDown={(event) => event.stopPropagation()} onDragOver={(event) => { const hasFiles = Array.from(event.dataTransfer?.types || []).includes('Files') || Array.from(event.dataTransfer?.items || []).some((item) => item.kind === 'file'); if (!hasFiles) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setSlotDropId(layer.id); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSlotDropId((current) => current === layer.id ? null : current); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setSlotDropId(null); const files = Array.from(event.dataTransfer?.files || []).filter((file) => isImageFileLike(file)); if (files.length) acceptInitialFiles(files, layer.id, true); }}>
                <div className="slot-gallery-heading"><div><strong>已选择的照片</strong><span>{gallerySources.length} 张</span></div><IconButton label="收起" onClick={() => setSlotGalleryId(null)}><ChevronUp size={17}/></IconButton></div>
                <div className="slot-gallery-grid">
                  {gallerySources.map((gallerySource, index) => <div className="slot-gallery-item" key={`${gallerySource.slice(-32)}-${index}`} title={galleryNames[index] || `第 ${index + 1} 张`}><img src={gallerySource} alt={galleryNames[index] || ''}/><button type="button" aria-label={`移除第 ${index + 1} 张图片`} onClick={() => removeSlotSourceAt(layer.id, index)}><X size={13}/></button></div>)}
                  <button type="button" className="slot-gallery-add" title="追加图片" onClick={() => requestSlotImage(layer.id, true)}><Plus size={22}/></button>
                </div>
              </div>}
            </div>;
          })}
        </div>
        <label className="check-row" title="开启后，拖动照片图层的边角会按原始宽高比例缩放，避免图片被横向或纵向拉伸变形；关闭后可自由改变宽度和高度。"><input type="checkbox" checked={lockAspectRatio} onChange={(event) => setLockAspectRatio(event.target.checked)}/><span>锁定照片宽高比</span></label>
        {cropLayer && slotSources[cropLayer.id] && <div className="crop-controls"><div className="crop-controls-heading"><strong><Crop size={16}/>裁切照片</strong><IconButton label="完成裁切" onClick={() => setCropModeId(null)}><Check size={16}/></IconButton></div><label className="crop-zoom-field"><span>缩放</span><input type="range" min="1" max="5" step="0.05" value={cropTransform.zoom} onChange={(event) => updatePhotoTransform(cropLayer.id, { zoom: Number(event.target.value) })}/><output>{Math.round(cropTransform.zoom * 100)}%</output></label><button className="wide-property-button" onClick={resetCrop}><RotateCcw size={16}/>重置裁切</button></div>}
        <input ref={input} hidden type="file" accept="image/*" multiple onChange={(event) => { const files = Array.from(event.target.files || []); if (files.length) { if (files.length > 1 || pendingAppend.current) acceptInitialFiles(files, pendingSlot.current, pendingAppend.current); else acceptFile(files[0], pendingSlot.current); } event.target.value = ''; pendingSlot.current = null; pendingAppend.current = false; }}/>
        {textLayers.length > 0 && <div className="use-text-layers"><div className="slot-list-heading"><strong>文字图层</strong><span>{textLayers.length}</span></div><div className="use-text-layer-list">{textLayers.map((layer) => <label key={layer.id} className="use-text-layer-field"><span>{layer.name}</span><textarea value={layer.text || ''} rows={Math.max(2, String(layer.text || '').split('\n').length)} onFocus={() => { finishTextEditing(); setSelectedId(layer.id); setCropModeId(null); }} onChange={(event) => updateTextLayerById(layer.id, event.target.value)}/></label>)}</div></div>}
        <div className="export-settings"><div className="slot-list-heading"><strong>导出设置</strong></div><div className="export-setting-row"><label><span>格式</span><select value={exportFormat} onChange={(event) => { const value = event.target.value; setExportFormat(value); if (value === 'jpg') setTransparent(false); }}><option value="png">PNG</option><option value="jpg">JPEG</option><option value="webp">WebP</option><option value="gif">GIF 动图</option></select></label><label title={exportScaleHint}><span title={exportScaleHint}>倍率</span><select title={exportScaleHint} value={exportScale} onChange={(event) => setExportScale(Number(event.target.value))}><option value="1" title={exportScaleHint}>1x</option><option value="2" title={exportScaleHint}>2x</option><option value="3" title={exportScaleHint}>3x</option></select></label></div><label className="check-row"><input type="checkbox" disabled={exportFormat === 'jpg'} checked={transparent} onChange={(event) => setTransparent(event.target.checked)}/><span>透明画布背景</span></label></div>
        <button type="button" className="secondary-button group-roster-import-button" title="选择 xlsx 群名单，按“工号”列下载成员头像，并可按工号、中文名、英文名或昵称依次替换文字图层。" disabled={groupRosterBusy} onClick={() => groupRosterInput.current?.click()}><Upload size={16}/>{groupRosterBusy ? '正在导入群名单（xlsx）' : '导入群名单（xlsx）'}</button>
        <input ref={groupRosterInput} className="hidden-input" type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) chooseGroupRosterFile(file); }}/>
      </section>
      <section className="result-area">
        <div className="result-heading"><div><p className="eyebrow">第 2 步</p><h2>生成结果</h2></div><div className="result-heading-actions"><div className="zoom-control"><IconButton label="缩小" onClick={() => setZoom((current) => current - .1)}><ZoomOut size={17}/></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton label="放大" onClick={() => setZoom((current) => current + .1)}><ZoomIn size={17}/></IconButton></div>{result && <div className="result-actions"><button className="primary-button" onClick={copyAgain}>{copied ? <Check size={17}/> : <Copy size={17}/>}{exportFormat === 'gif' ? '复制 GIF' : '复制图片'}</button></div>}</div></div>
        <div className="result-stage has-result" onWheel={handleResultWheel} onContextMenu={openContextMenu} onDragStart={(event) => event.preventDefault()} onDragOver={(event) => { if (Array.from(event.dataTransfer.types || []).includes('Files')) event.preventDefault(); }} onDrop={dropOnSlot}>
          <UseStage composition={composition} slotSources={slotSources} slotSourceLists={slotSourceLists} slotTransforms={slotTransforms} selectedId={selectedId} setSelectedId={setSelectedId} updateLayer={updateLayer} cropModeId={cropModeId} setCropModeId={setCropModeId} updatePhotoTransform={updatePhotoTransform} onRequestSlot={requestSlotImage} zoom={zoom} pan={pan} panning={panning} onPanStart={beginPan} transparent={transparent} lockAspectRatio={lockAspectRatio} textEditingId={textEditingId} textSelection={textSelection} onEditText={editTextLayer} onTextChange={updateTextLayer} onTextSelectionChange={setTextSelection} onTextDone={finishTextEditing}/>
        </div>
      </section>
    </div>
    {groupRosterChoice && <div className="group-roster-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setGroupRosterChoice(null); }}>
      <div className="group-roster-dialog" role="dialog" aria-modal="true" aria-labelledby="group-roster-title">
        <div className="group-roster-heading"><div><strong id="group-roster-title">是否替换文本？</strong><span>{groupRosterChoice.fileName}</span></div><IconButton label="取消" onClick={() => setGroupRosterChoice(null)}><X size={17}/></IconButton></div>
        <p>选择 Excel 第一行中的字段，将按从上到下的顺序替换可编辑文字图层。锁定文本的图层不会被修改。</p>
        <div className="group-roster-options">
           {[['workerId', '工号'], ['chineseName', '中文名'], ['englishName', '英文名'], ['nickname', '昵称'], ['none', '否']].map(([value, label]) => <button type="button" key={value} className={value === 'none' ? 'secondary-button' : 'primary-button'} onClick={() => importGroupRosterRows(groupRosterChoice.rows, value)}>{label}</button>)}
        </div>
      </div>
    </div>}
    {groupRosterBusy && <div className="group-roster-busy" role="status" aria-live="polite"><div><RefreshCw size={20}/><strong>正在导入群名单</strong><span>正在下载成员头像，请稍候…</span></div></div>}
    {contextMenu && <div className="result-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button onClick={() => { setContextMenu(null); copyAgain(); }}><Copy size={16}/>{exportFormat === 'gif' ? '复制 GIF' : '复制图片'}</button></div>}
    <ExportProgressOverlay progress={exportProgress} onCancel={cancelExport}/>
    {slotContextMenu && <div className="result-context-menu" style={{ left: slotContextMenu.x, top: slotContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button onClick={() => { const slotId = slotContextMenu.id; setSlotContextMenu(null); pasteClipboardImage(slotId); }}><Clipboard size={16}/>粘贴图片</button><button className="danger" disabled={!slotSources[slotContextMenu.id]} onClick={() => { const slotId = slotContextMenu.id; setSlotContextMenu(null); removeSlotSource(slotId); }}><Trash2 size={16}/>删除图片</button></div>}
  </main>;
}

const appRoot = globalThis.__memeHelperReactRoot || createRoot(document.getElementById('root'));
globalThis.__memeHelperReactRoot = appRoot;
appRoot.render(<React.StrictMode><App/></React.StrictMode>);
