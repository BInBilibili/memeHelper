import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { Stage, Layer, Group, Ellipse, Image as KonvaImage, Rect, Text as KonvaText, Transformer } from 'react-konva';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowLeft, Bold, Check, ChevronDown, ChevronUp,
  Circle, Clipboard, Copy, Download, Eye, EyeOff, FileImage, GripVertical, ImagePlus,
  Italic, Layers3, LayoutTemplate, MoreHorizontal, PackageOpen, Pencil, Plus, RotateCcw,
  Save, Shapes, Sparkles, Square, Strikethrough, Trash2, Type, Underline, Undo2, Upload,
  X, ZoomIn, ZoomOut
} from 'lucide-react';
import bundledTemplates from './bundled-templates.json';
import './styles.css';

const browserDesktop = {
  isDesktop: false,
  loadConfig: async () => ({ theme: 'system', autoCopy: true, templatesFile: 'templates.json' }),
  loadTemplates: async () => JSON.parse(localStorage.getItem('meme-helper-templates') || '[]'),
  saveTemplates: async (value) => localStorage.setItem('meme-helper-templates', JSON.stringify(value)),
  publishTemplates: async (value) => {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'bundled-templates.json'; a.click();
    URL.revokeObjectURL(url);
    return 'bundled-templates.json';
  },
  copyImage: async (dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
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
  publishTemplates: (templates) => invoke('publish_templates', { templates }),
  copyImage: (dataUrl) => invoke('copy_image', { dataUrl }),
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

function drawTextLayer(ctx, layer) {
  const fontSize = layer.fontSize || 48;
  const fontTokens = String(layer.fontStyle || '').split(' ');
  const fontStyle = `${fontTokens.includes('italic') ? 'italic ' : ''}${fontTokens.includes('bold') ? 'bold ' : ''}`;
  const fontFamily = layer.fontFamily || 'Microsoft YaHei';
  ctx.font = `${fontStyle}${fontSize}px "${fontFamily}"`;
  ctx.fillStyle = layer.fill || '#22211f';
  ctx.textBaseline = 'top';
  ctx.textAlign = layer.align || 'left';
  const lines = wrapCanvasText(ctx, layer.text, layer.width);
  const lineHeight = fontSize * (layer.lineHeight || 1.25);
  const anchorX = layer.align === 'center' ? layer.width / 2 : layer.align === 'right' ? layer.width : 0;
  const decorations = String(layer.textDecoration || '').split(' ');
  lines.forEach((line, index) => {
    const y = index * lineHeight;
    if (y + fontSize > layer.height) return;
    ctx.fillText(line, anchorX, y, layer.width);
    const metrics = ctx.measureText(line);
    const startX = layer.align === 'center' ? anchorX - metrics.width / 2 : layer.align === 'right' ? anchorX - metrics.width : anchorX;
    ctx.strokeStyle = layer.fill || '#22211f'; ctx.lineWidth = Math.max(1, fontSize / 18);
    if (decorations.includes('underline')) { ctx.beginPath(); ctx.moveTo(startX, y + fontSize * 1.05); ctx.lineTo(startX + metrics.width, y + fontSize * 1.05); ctx.stroke(); }
    if (decorations.includes('line-through')) { ctx.beginPath(); ctx.moveTo(startX, y + fontSize * .55); ctx.lineTo(startX + metrics.width, y + fontSize * .55); ctx.stroke(); }
  });
}

async function renderTemplate(template, replacements, scale = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(template.width * scale);
  canvas.height = Math.round(template.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, template.width, template.height);
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
      if (layer.fit === 'cover') {
        const crop = getCoverCrop(image, layer.width, layer.height);
        ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, layer.width, layer.height);
      } else {
        ctx.drawImage(image, 0, 0, layer.width, layer.height);
      }
    } finally { ctx.restore(); }
  }
  return canvas.toDataURL('image/png');
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
  const historyRef = useRef([]);
  const stateRef = useRef();
  const [historyCount, setHistoryCount] = useState(0);
  const [state, setState] = useState(() => {
    const initial = typeof initializer === 'function' ? initializer() : initializer;
    stateRef.current = initial;
    return initial;
  });

  const commit = useCallback((updater) => {
    const previous = stateRef.current;
    const next = typeof updater === 'function' ? updater(previous) : updater;
    if (Object.is(previous, next)) return;
    historyRef.current = [...historyRef.current.slice(-(limit - 1)), previous];
    stateRef.current = next;
    setState(next);
    setHistoryCount(historyRef.current.length);
  }, [limit]);

  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) return false;
    stateRef.current = previous;
    setState(previous);
    setHistoryCount(historyRef.current.length);
    return true;
  }, []);

  return [state, commit, undo, historyCount > 0];
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
  const [config, setConfig] = useState({ theme: 'system', autoCopy: true, templatesFile: 'templates.json' });
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState({ name: 'library' });
  const [toast, setToast] = useState(null);
  const [query, setQuery] = useState('');
  const toastTimer = useRef();

  const notify = useCallback((message, kind = '') => {
    clearTimeout(toastTimer.current); setToast({ message, kind });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    Promise.all([desktop.loadTemplates(), desktop.loadConfig()]).then(([saved, loadedConfig]) => {
      const localTemplates = Array.isArray(saved) ? saved : [];
      const builtInTemplates = bundledTemplates.length ? structuredClone(bundledTemplates) : starterTemplates();
      const merged = localTemplates.length ? [...localTemplates, ...builtInTemplates] : builtInTemplates;
      const next = merged.filter((item, index) => merged.findIndex((candidate) => candidate.id === item.id || (candidate.name === item.name && candidate.width === item.width && candidate.height === item.height)) === index);
      applyTheme(loadedConfig?.theme);
      setTemplates(next); setConfig((previous) => ({ ...previous, ...(loadedConfig || {}) })); setReady(true);
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

  const saveTemplate = async (template) => {
    const existing = templates.some((item) => item.id === template.id);
    const next = existing ? templates.map((item) => item.id === template.id ? template : item) : [template, ...templates];
    await commitTemplates(next); setPage({ name: 'library' }); notify('模板已保存');
  };

  const deleteTemplate = async (id) => {
    if (!confirm('确定删除这个模板吗？此操作不可撤销。')) return;
    await commitTemplates(templates.filter((item) => item.id !== id)); notify('模板已删除');
  };

  const publishTemplates = async () => {
    const filePath = await desktop.publishTemplates(templates);
    if (filePath) notify(desktop.isDesktop ? '模板包已生成，可随项目提交到 GitHub' : '模板包已下载');
  };

  if (!ready) return <div className="loading-screen"><Sparkles size={26}/><span>正在准备模板库...</span></div>;

  return <div className="app-shell">
    {page.name === 'library' && <Library templates={templates} query={query} setQuery={setQuery} onCreate={() => setPage({ name: 'editor' })} onEdit={(template) => setPage({ name: 'editor', template })} onUse={(template, file) => setPage({ name: 'use', template, file })} onDelete={deleteTemplate} onPublish={publishTemplates} notify={notify}/>}
    {page.name === 'editor' && <Editor initial={page.template} onBack={() => setPage({ name: 'library' })} onSave={saveTemplate} notify={notify}/>}
    {page.name === 'use' && <UseTemplate template={page.template} initialFile={page.file} autoCopy={config.autoCopy !== false} onBack={() => setPage({ name: 'library' })} onEdit={() => setPage({ name: 'editor', template: page.template })} notify={notify}/>}
    <Toast toast={toast}/>
  </div>;
}

function Brand() {
  return <div className="brand"><div className="brand-mark"><Sparkles size={20}/></div><span>MemeHelper</span></div>;
}

function Library({ templates, query, setQuery, onCreate, onEdit, onUse, onDelete, onPublish, notify }) {
  const filtered = templates.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  return <main className="library-page">
    <header className="topbar"><Brand/><div className="topbar-actions"><span className="storage-note">{desktop.isDesktop ? '模板保存在程序目录' : '模板保存在浏览器'}</span><button className="secondary-button" onClick={onPublish}><PackageOpen size={17}/>发布模板包</button><button className="primary-button" onClick={onCreate}><Plus size={18}/>新建模板</button></div></header>
    <section className="library-heading"><div><p className="eyebrow">模板工作台</p><h1>选择一个模板，马上开始</h1><p>点击使用，或把图片直接拖到模板上。</p></div><div className="search-box"><LayoutTemplate size={18}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模板"/></div></section>
    <section className="template-grid">
      <button className="new-template-card" onClick={onCreate}><span className="new-icon"><Plus size={26}/></span><strong>创建新模板</strong><small>设置底图与照片位置</small></button>
      {filtered.map((template) => <TemplateCard key={template.id} template={template} onUse={onUse} onEdit={onEdit} onDelete={onDelete} notify={notify}/>)}
    </section>
    {!filtered.length && <div className="empty-state"><LayoutTemplate size={34}/><h3>没有找到模板</h3><p>换个关键词，或新建一个模板。</p></div>}
    <footer className="app-footer"><span>{templates.length} 个模板</span><span>拖入图片即可生成并复制</span></footer>
  </main>;
}

function TemplateCard({ template, onUse, onEdit, onDelete, notify }) {
  const [preview, setPreview] = useState('');
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => { let alive = true; renderTemplate(template).then((data) => alive && setPreview(data)); return () => { alive = false; }; }, [template]);
  const drop = (event) => {
    event.preventDefault(); setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file?.type?.startsWith('image/')) return notify('请拖入图片文件', 'error');
    onUse(template, file);
  };
  return <article className={`template-card ${dragging ? 'dragging' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
    <div className="template-preview" onClick={() => onUse(template)}>{preview && <img src={preview} alt="" draggable={false}/>}<div className="drop-hint"><Upload size={28}/><strong>松开即可生成</strong></div></div>
    <div className="template-meta"><div><h3>{template.name}</h3><span>{template.width} x {template.height} · {template.layers.filter((x) => x.type === 'slot').length} 个照片位</span></div><div className="card-menu-wrap"><IconButton label="模板操作" onClick={() => setMenu(!menu)}><MoreHorizontal size={19}/></IconButton>{menu && <div className="context-menu"><button onClick={() => { setMenu(false); onEdit(template); }}><Pencil size={16}/>编辑模板</button><button className="danger" onClick={() => onDelete(template.id)}><Trash2 size={16}/>删除模板</button></div>}</div></div>
    <div className="card-actions"><button className="secondary-button" onClick={() => onEdit(template)}><Pencil size={16}/>编辑</button><button className="primary-button grow" onClick={() => onUse(template)}><Sparkles size={17}/>使用模板</button></div>
  </article>;
}

function Editor({ initial, onBack, onSave, notify }) {
  const [draft, commitDraft, undo, canUndo] = useUndoState(() => initial ? structuredClone(initial) : { id: uid(), name: '未命名模板', width: 800, height: 800, createdAt: Date.now(), updatedAt: Date.now(), layers: [] });
  const [selectedId, setSelectedId] = useState(draft.layers.at(-1)?.id || null);
  const { zoom, pan, panning, setZoom, zoomAtPointer, beginPan } = useCanvasViewport(.72, .2, 1.3);
  const [dirty, setDirty] = useState(false);
  const [shapeMenu, setShapeMenu] = useState(false);
  const [layerMenu, setLayerMenu] = useState(null);
  const memeInput = useRef();
  const selected = draft.layers.find((item) => item.id === selectedId);
  const updateDraft = useCallback((updater) => { commitDraft(updater); setDirty(true); }, [commitDraft]);
  const updateLayer = (id, patch) => updateDraft((prev) => ({ ...prev, layers: prev.layers.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const undoDraft = useCallback(() => { if (undo()) setDirty(true); }, [undo]);
  const tryBack = useCallback(() => {
    if (!dirty || confirm('尚未保存，确定离开编辑器吗？')) onBack();
  }, [dirty, onBack]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault(); undoDraft();
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
  }, [tryBack, undoDraft]);

  useEffect(() => {
    if (selectedId && !draft.layers.some((layer) => layer.id === selectedId)) setSelectedId(null);
  }, [draft.layers, selectedId]);

  const addImage = async (file) => {
    try {
      const src = await fileToDataUrl(file); const image = await loadImage(src);
      const maxW = draft.width * .9; const maxH = draft.height * .9;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1);
      const width = Math.round(image.width * scale); const height = Math.round(image.height * scale);
      const layer = { id: uid(), name: file.name.replace(/\.[^.]+$/, ''), type: 'static', src, x: Math.round((draft.width - width) / 2), y: Math.round((draft.height - height) / 2), width, height, rotation: 0, visible: true, fit: 'fill' };
      updateDraft((prev) => ({ ...prev, layers: [...prev.layers, layer] })); setSelectedId(layer.id);
    } catch (error) { notify(error.message, 'error'); }
  };

  const addEmptySlot = (shape) => {
    const size = Math.round(Math.min(draft.width, draft.height) * .52);
    const width = shape === 'circle' ? size : Math.round(draft.width * .6);
    const height = shape === 'circle' ? size : Math.round(draft.height * .48);
    const shapeName = shape === 'circle' ? '圆形' : shape === 'rounded' ? '圆角矩形' : '矩形';
    const layer = { id: uid(), name: `${shapeName}照片 ${draft.layers.filter((x) => x.type === 'slot').length + 1}`, type: 'slot', shape, src: '', x: Math.round((draft.width - width) / 2), y: Math.round((draft.height - height) / 2), width, height, rotation: 0, visible: true, fit: 'cover' };
    updateDraft((prev) => ({ ...prev, layers: [...prev.layers, layer] })); setSelectedId(layer.id);
    setShapeMenu(false);
  };

  const addTextLayer = () => {
    const layer = { id: uid(), name: `文字 ${draft.layers.filter((item) => item.type === 'text').length + 1}`, type: 'text', text: '输入文字', x: Math.round(draft.width * .18), y: Math.round(draft.height * .18), width: Math.round(draft.width * .64), height: 130, rotation: 0, visible: true, fontSize: 48, fontFamily: 'Microsoft YaHei', fontStyle: 'normal', textDecoration: '', align: 'center', fill: '#22211f', lineHeight: 1.25 };
    updateDraft((prev) => ({ ...prev, layers: [...prev.layers, layer] })); setSelectedId(layer.id);
  };

  const openLayerMenu = (id, event) => {
    event.preventDefault(); event.stopPropagation(); setSelectedId(id);
    setLayerMenu({ id, x: Math.min(event.clientX, window.innerWidth - 166), y: Math.min(event.clientY, window.innerHeight - 52) });
  };

  const removeLayer = (id) => { updateDraft((prev) => ({ ...prev, layers: prev.layers.filter((x) => x.id !== id) })); setSelectedId(null); };
  const moveLayer = (id, direction) => updateDraft((prev) => {
    const index = prev.layers.findIndex((x) => x.id === id); const nextIndex = clamp(index + direction, 0, prev.layers.length - 1);
    const layers = [...prev.layers]; const [item] = layers.splice(index, 1); layers.splice(nextIndex, 0, item); return { ...prev, layers };
  });
  const save = () => {
    if (!draft.name.trim()) return notify('请填写模板名称', 'error');
    if (!draft.layers.length) return notify('请至少添加一个图层', 'error');
    if (!draft.layers.some((layer) => layer.type === 'slot')) return notify('请至少添加一个照片位置', 'error');
    const finalDraft = { ...draft, name: draft.name.trim(), updatedAt: Date.now() };
    onSave(finalDraft);
  };

  return <main className="editor-page">
    <header className="editor-topbar"><div className="editor-left"><IconButton label="返回模板库" onClick={tryBack}><ArrowLeft size={21}/></IconButton><div className="title-field"><input value={draft.name} onChange={(e) => updateDraft({ ...draft, name: e.target.value })}/><span>{draft.width} x {draft.height}px</span></div></div><div className="editor-center"><span className="status-dot"></span>{dirty ? '有未保存的修改' : '已保存'}</div><div className="editor-actions"><IconButton label="撤销 (Ctrl+Z)" onClick={undoDraft} disabled={!canUndo}><Undo2 size={18}/></IconButton><button className="secondary-button" onClick={tryBack}>取消</button><button className="primary-button" onClick={save}><Save size={17}/>保存模板</button></div></header>
    <div className="editor-body">
      <aside className="layers-panel"><div className="panel-title"><div><span>图层</span><small>{draft.layers.length}</small></div><IconButton label="添加可替换照片" onClick={(event) => { event.stopPropagation(); setShapeMenu(!shapeMenu); }}><Plus size={18}/></IconButton></div><div className="layer-add-row"><button onClick={() => memeInput.current.click()}><ImagePlus size={18}/><span>添加固定图层</span></button><div className="shape-picker-wrap"><button onClick={(event) => { event.stopPropagation(); setShapeMenu(!shapeMenu); }}><Shapes size={18}/><span>添加可替换照片</span></button>{shapeMenu && <div className="shape-picker" onPointerDown={(event) => event.stopPropagation()}><button onClick={() => addEmptySlot('rect')}><Square size={17}/><span>矩形</span></button><button onClick={() => addEmptySlot('circle')}><Circle size={17}/><span>圆形</span></button><button onClick={() => addEmptySlot('rounded')}><Shapes size={17}/><span>圆角矩形</span></button></div>}</div><button onClick={addTextLayer}><Type size={18}/><span>添加文字</span></button></div><input ref={memeInput} hidden type="file" accept="image/*" onChange={(event) => event.target.files[0] && addImage(event.target.files[0])}/>
        <div className="layers-list">{[...draft.layers].reverse().map((layer) => <div key={layer.id} className={`layer-row ${selectedId === layer.id ? 'selected' : ''}`} onClick={() => setSelectedId(layer.id)} onContextMenu={(event) => openLayerMenu(layer.id, event)}><GripVertical size={15} className="grip"/><div className={`layer-thumb ${layer.type}`}><LayerThumb layer={layer}/></div><div className="layer-copy"><strong>{layer.name}</strong><span>{layer.type === 'slot' ? `${shapeOf(layer) === 'circle' ? '圆形' : shapeOf(layer) === 'rounded' ? '圆角矩形' : '矩形'}照片` : layer.type === 'text' ? '文字图层' : '固定图层'}</span></div><IconButton label={layer.visible ? '隐藏图层' : '显示图层'} onClick={(event) => { event.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }}>{layer.visible ? <Eye size={16}/> : <EyeOff size={16}/>}</IconButton></div>)}</div>
        {!draft.layers.length && <div className="layers-empty"><Layers3 size={28}/><p>先添加 Meme 底图，再添加一个照片位置。</p></div>}
      </aside>
      <section className="canvas-workspace"><div className="canvas-toolbar"><div className="canvas-size"><label>画布</label><input type="number" min="100" max="4000" value={draft.width} onChange={(e) => updateDraft({ ...draft, width: clamp(e.target.value, 100, 4000) })}/><span>×</span><input type="number" min="100" max="4000" value={draft.height} onChange={(e) => updateDraft({ ...draft, height: clamp(e.target.value, 100, 4000) })}/></div><div className="zoom-control"><IconButton label="缩小" onClick={() => setZoom((current) => current - .1)}><ZoomOut size={17}/></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton label="放大" onClick={() => setZoom((current) => current + .1)}><ZoomIn size={17}/></IconButton></div></div><div className={`canvas-scroll pan-viewport ${panning ? 'panning' : ''}`} onWheel={zoomAtPointer} onMouseDown={(event) => { if (event.target === event.currentTarget) beginPan(event); }}><div className="stage-shadow" style={{ width: draft.width * zoom, height: draft.height * zoom, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)` }}><EditorStage template={draft} selectedId={selectedId} setSelectedId={setSelectedId} updateLayer={updateLayer} onLayerContextMenu={openLayerMenu} onPanStart={beginPan} zoom={zoom}/></div></div></section>
      <aside className="properties-panel"><div className="panel-title"><span>属性</span></div>{selected ? <Properties layer={selected} update={(patch) => updateLayer(selected.id, patch)} remove={() => removeLayer(selected.id)} move={(direction) => moveLayer(selected.id, direction)}/> : <div className="property-empty"><Pencil size={26}/><p>选择一个图层后，可调整位置、尺寸和旋转。</p></div>}</aside>
    </div>
    {layerMenu && <div className="layer-context-menu" style={{ left: layerMenu.x, top: layerMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button onClick={() => { removeLayer(layerMenu.id); setLayerMenu(null); }}><Trash2 size={16}/>删除图层</button></div>}
  </main>;
}

function LayerThumb({ layer }) {
  const image = useHtmlImage(layer.src);
  if (layer.type === 'text') return <Type size={18}/>;
  if (image) return <img src={layer.src} alt=""/>;
  return <span className={`shape-thumb ${shapeOf(layer)}`}></span>;
}

function EditorStage({ template, selectedId, setSelectedId, updateLayer, onLayerContextMenu, onPanStart, zoom }) {
  const trRef = useRef(); const nodeRefs = useRef({});
  useEffect(() => { const node = nodeRefs.current[selectedId]; if (trRef.current) { trRef.current.nodes(node ? [node] : []); trRef.current.getLayer()?.batchDraw(); } }, [selectedId, template.layers]);
  return <Stage width={template.width * zoom} height={template.height * zoom} scaleX={zoom} scaleY={zoom} onMouseDown={(event) => { if (event.target === event.target.getStage() || event.target.name() === 'editor-background') { setSelectedId(null); onPanStart(event); } }}><Layer><Rect name="editor-background" width={template.width} height={template.height} fill="#fff"/>{template.layers.map((layer) => <EditorLayer key={layer.id} layer={layer} setRef={(node) => nodeRefs.current[layer.id] = node} onSelect={() => setSelectedId(layer.id)} onContextMenu={(event) => onLayerContextMenu(layer.id, event.evt)} onChange={(patch) => updateLayer(layer.id, patch)}/>)}<Transformer ref={trRef} rotateEnabled enabledAnchors={['top-left','top-right','bottom-left','bottom-right','middle-left','middle-right','top-center','bottom-center']} borderStroke="#e24b35" anchorFill="#fff" anchorStroke="#e24b35" anchorSize={10 / zoom} borderStrokeWidth={2 / zoom} boundBoxFunc={(oldBox, newBox) => (newBox.width < 24 || newBox.height < 24) ? oldBox : newBox}/></Layer></Stage>;
}

function EditorLayer({ layer, setRef, onSelect, onContextMenu, onChange, interactive = true, selectable = interactive, source, highlight = false }) {
  const image = useHtmlImage(source ?? layer.src);
  const crop = image && layer.fit === 'cover' ? getCoverCrop(image, layer.width, layer.height) : undefined;
  if (!layer.visible) return null;
  const common = { ref: setRef, x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotation: layer.rotation || 0, draggable: interactive, listening: selectable };
  if (selectable) Object.assign(common, { onClick: onSelect, onTap: onSelect, onContextMenu });
  if (interactive) Object.assign(common, { onDragEnd: (event) => onChange({ x: Math.round(event.target.x()), y: Math.round(event.target.y()) }), onTransformEnd: (event) => { const node = event.target; const sx = node.scaleX(), sy = node.scaleY(); node.scaleX(1); node.scaleY(1); onChange({ x: Math.round(node.x()), y: Math.round(node.y()), width: Math.max(10, Math.round(node.width() * sx)), height: Math.max(10, Math.round(node.height() * sy)), rotation: Math.round(node.rotation()) }); } });
  if (layer.type === 'text') return <KonvaText {...common} text={layer.text || ''} fontSize={layer.fontSize || 48} fontFamily={layer.fontFamily || 'Microsoft YaHei'} fontStyle={layer.fontStyle || 'normal'} textDecoration={layer.textDecoration || ''} align={layer.align || 'left'} fill={layer.fill || '#22211f'} lineHeight={layer.lineHeight || 1.25} wrap="char" verticalAlign="top"/>;
  const clipFunc = (ctx) => traceLayerShape(ctx, layer);
  const placeholderProps = { fill: highlight ? 'rgba(233,78,55,.14)' : '#eceae4', stroke: highlight ? '#e94e37' : '#77746d', strokeWidth: highlight ? 5 : 2, dash: [12, 8] };
  return <Group {...common} clipFunc={layer.type === 'slot' ? clipFunc : undefined}>
    {image ? <KonvaImage image={image} width={layer.width} height={layer.height} crop={crop}/> : shapeOf(layer) === 'circle' ? <Ellipse x={layer.width / 2} y={layer.height / 2} radiusX={layer.width / 2} radiusY={layer.height / 2} {...placeholderProps}/> : <Rect width={layer.width} height={layer.height} cornerRadius={shapeOf(layer) === 'rounded' ? Math.min(36, layer.width / 4, layer.height / 4) : 0} {...placeholderProps}/>}
  </Group>;
}

function NumberField({ label, value, onChange, suffix }) { return <label className="number-field"><span>{label}</span><div><input type="number" value={Math.round(value)} onChange={(e) => onChange(Number(e.target.value))}/>{suffix && <em>{suffix}</em>}</div></label>; }

function Properties({ layer, update, remove, move }) {
  const fontTokens = String(layer.fontStyle || '').split(' ').filter((token) => token && token !== 'normal');
  const decorationTokens = String(layer.textDecoration || '').split(' ').filter(Boolean);
  const toggleFont = (token) => update({ fontStyle: fontTokens.includes(token) ? fontTokens.filter((item) => item !== token).join(' ') || 'normal' : [...fontTokens, token].join(' ') });
  const toggleDecoration = (token) => update({ textDecoration: decorationTokens.includes(token) ? decorationTokens.filter((item) => item !== token).join(' ') : [...decorationTokens, token].join(' ') });

  return <div className="property-content">
    <label className="text-field"><span>图层名称</span><input value={layer.name} onChange={(event) => update({ name: event.target.value })}/></label>
    {layer.type === 'text' && <>
      <div className="property-section text-content-section"><h4>文字内容</h4><textarea value={layer.text || ''} onChange={(event) => update({ text: event.target.value })}/></div>
      <div className="property-section"><h4>字体</h4><select className="property-select" value={layer.fontFamily || 'Microsoft YaHei'} onChange={(event) => update({ fontFamily: event.target.value })}><option value="Microsoft YaHei">微软雅黑</option><option value="SimHei">黑体</option><option value="SimSun">宋体</option><option value="KaiTi">楷体</option><option value="Arial">Arial</option><option value="Segoe UI">Segoe UI</option></select><div className="text-format-row"><label><span>字号</span><input type="number" min="8" max="400" value={layer.fontSize || 48} onChange={(event) => update({ fontSize: clamp(event.target.value, 8, 400) })}/></label><input className="color-swatch" type="color" title="文字颜色" value={layer.fill || '#22211f'} onChange={(event) => update({ fill: event.target.value })}/></div><div className="format-buttons"><button title="加粗" className={fontTokens.includes('bold') ? 'active' : ''} onClick={() => toggleFont('bold')}><Bold size={17}/></button><button title="斜体" className={fontTokens.includes('italic') ? 'active' : ''} onClick={() => toggleFont('italic')}><Italic size={17}/></button><button title="下划线" className={decorationTokens.includes('underline') ? 'active' : ''} onClick={() => toggleDecoration('underline')}><Underline size={17}/></button><button title="删除线" className={decorationTokens.includes('line-through') ? 'active' : ''} onClick={() => toggleDecoration('line-through')}><Strikethrough size={17}/></button></div><div className="format-buttons align-buttons"><button title="左对齐" className={layer.align === 'left' ? 'active' : ''} onClick={() => update({ align: 'left' })}><AlignLeft size={17}/></button><button title="居中" className={layer.align === 'center' ? 'active' : ''} onClick={() => update({ align: 'center' })}><AlignCenter size={17}/></button><button title="右对齐" className={layer.align === 'right' ? 'active' : ''} onClick={() => update({ align: 'right' })}><AlignRight size={17}/></button></div></div>
    </>}
    <div className="property-section"><h4>位置</h4><div className="property-grid"><NumberField label="X" value={layer.x} onChange={(x) => update({ x })}/><NumberField label="Y" value={layer.y} onChange={(y) => update({ y })}/></div></div>
    <div className="property-section"><h4>尺寸</h4><div className="property-grid"><NumberField label="宽" value={layer.width} onChange={(width) => update({ width: Math.max(10, width) })}/><NumberField label="高" value={layer.height} onChange={(height) => update({ height: Math.max(10, height) })}/></div></div>
    <div className="property-section"><h4>旋转</h4><NumberField label="角度" value={layer.rotation} onChange={(rotation) => update({ rotation })} suffix="°"/><input className="range" type="range" min="-180" max="180" value={layer.rotation} onChange={(event) => update({ rotation: Number(event.target.value) })}/></div>
    {layer.type === 'slot' && <><div className="property-section"><h4>槽位形状</h4><div className="shape-segmented"><button className={shapeOf(layer) === 'rect' ? 'active' : ''} onClick={() => update({ shape: 'rect' })}>矩形</button><button className={shapeOf(layer) === 'circle' ? 'active' : ''} onClick={() => update({ shape: 'circle' })}>圆形</button><button className={shapeOf(layer) === 'rounded' ? 'active' : ''} onClick={() => update({ shape: 'rounded' })}>圆角</button></div></div><div className="property-section"><h4>照片填充</h4><div className="segmented"><button className={layer.fit === 'cover' ? 'active' : ''} onClick={() => update({ fit: 'cover' })}>裁切铺满</button><button className={layer.fit === 'fill' ? 'active' : ''} onClick={() => update({ fit: 'fill' })}>拉伸填满</button></div></div></>}
    <div className="property-section"><h4>图层顺序</h4><div className="order-buttons"><button onClick={() => move(1)}><ChevronUp size={17}/>上移</button><button onClick={() => move(-1)}><ChevronDown size={17}/>下移</button></div></div>
    <button className="delete-button" onClick={remove}><Trash2 size={17}/>删除图层</button>
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

function UseStage({ composition, slotSources, selectedId, setSelectedId, updateLayer, onRequestSlot, zoom, pan, panning, onPanStart }) {
  const hostRef = useRef();
  const transformerRef = useRef();
  const nodeRefs = useRef({});
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });

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
    const node = slotSources[selectedId] ? nodeRefs.current[selectedId] : null;
    if (transformerRef.current) {
      transformerRef.current.nodes(node ? [node] : []);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [composition.layers, scale, selectedId, slotSources]);

  return <div className={`result-canvas-host pan-viewport ${panning ? 'panning' : ''}`} ref={hostRef} onMouseDown={(event) => { if (event.target === event.currentTarget) onPanStart(event); }}>
    {hostSize.width > 0 && <div className="result-canvas-frame" style={{ width: composition.width * scale, height: composition.height * scale, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)` }}>
      <Stage width={composition.width * scale} height={composition.height * scale} scaleX={scale} scaleY={scale} onMouseDown={(event) => { if (event.target === event.target.getStage() || event.target.name() === 'result-background') { setSelectedId(null); onPanStart(event); } }}>
        <Layer>
          <Rect name="result-background" width={composition.width} height={composition.height} fill="#fff"/>
          {composition.layers.map((layer) => <EditorLayer
            key={layer.id}
            layer={layer}
            source={layer.type === 'slot' ? slotSources[layer.id] : undefined}
            interactive={layer.type === 'slot' && Boolean(slotSources[layer.id])}
            selectable={layer.type === 'slot'}
            highlight={layer.type === 'slot' && !slotSources[layer.id]}
            setRef={(node) => { if (layer.type === 'slot') nodeRefs.current[layer.id] = node; }}
            onSelect={() => { setSelectedId(layer.id); if (!slotSources[layer.id]) onRequestSlot(layer.id); }}
            onChange={(patch) => updateLayer(layer.id, patch)}
          />)}
          <Transformer
            ref={transformerRef}
            rotateEnabled={false}
            keepRatio={false}
            flipEnabled={false}
            enabledAnchors={['top-left','top-right','bottom-left','bottom-right','middle-left','middle-right','top-center','bottom-center']}
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
  const [session, commitSession, undo, canUndo] = useUndoState(() => ({
    composition: structuredClone(template),
    slotSources: {},
    slotNames: {}
  }));
  const { composition, slotSources, slotNames } = session;
  const [result, setResult] = useState('');
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const { zoom, pan, panning, setZoom, zoomAtPointer, beginPan } = useCanvasViewport(1, .5, 3);
  const [selectedId, setSelectedId] = useState(template.layers.find((layer) => layer.type === 'slot')?.id || null);
  const [contextMenu, setContextMenu] = useState(null);
  const input = useRef();
  const pendingSlot = useRef(null);
  const initialHandled = useRef(false);
  const renderRequest = useRef(0);
  const slots = composition.layers.filter((layer) => layer.type === 'slot');

  const updateLayer = useCallback((id, patch) => {
    commitSession((previous) => ({
      ...previous,
      composition: {
        ...previous.composition,
        layers: previous.composition.layers.map((layer) => layer.id === id ? { ...layer, ...patch } : layer)
      }
    }));
  }, [commitSession]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault(); undo();
      }
      if (event.key === 'Escape' && !event.repeat) {
        event.preventDefault();
        onBack();
      }
    };
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', closeMenu);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', closeMenu);
    };
  }, [onBack, undo]);

  useEffect(() => {
    if (!Object.keys(slotSources).length) { setResult(''); setCopied(false); return; }
    const request = ++renderRequest.current;
    let cancelled = false;
    setWorking(true);
    setCopied(false);
    renderTemplate(composition, slotSources).then(async (dataUrl) => {
      if (cancelled || request !== renderRequest.current) return;
      setResult(dataUrl);
      if (!autoCopy) {
        setCopied(false);
        notify('结果已更新');
        return;
      }
      try {
        await desktop.copyImage(dataUrl);
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
  }, [autoCopy, composition, slotSources, notify]);

  const acceptFile = useCallback(async (file, targetId) => {
    try {
      const slotId = targetId || selectedId || composition.layers.find((layer) => layer.type === 'slot')?.id;
      if (!slotId) return notify('模板中没有可替换照片图层', 'error');
      const dataUrl = await fileToDataUrl(file);
      commitSession((previous) => ({
        ...previous,
        slotSources: { ...previous.slotSources, [slotId]: dataUrl },
        slotNames: { ...previous.slotNames, [slotId]: file.name }
      }));
      setSelectedId(slotId);
    } catch (error) { notify(error.message, 'error'); }
  }, [commitSession, composition.layers, notify, selectedId]);

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
      const dataUrl = await renderTemplate(composition, slotSources);
      setResult(dataUrl);
      return dataUrl;
    }
    return result;
  }, [composition, result, slotSources, working]);

  const copyAgain = useCallback(async () => {
    const dataUrl = await currentResult();
    if (!dataUrl) return;
    try { await desktop.copyImage(dataUrl); setCopied(true); notify('已复制，可粘贴到聊天窗口或文件夹'); }
    catch { setCopied(false); notify('剪贴板不可用，请保存 PNG', 'error'); }
  }, [currentResult, notify]);

  const save = async () => {
    const dataUrl = await currentResult();
    if (!dataUrl) return;
    const path = await desktop.saveImage(dataUrl, `${template.name}-${Date.now()}.png`);
    if (path) notify('图片已保存');
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

  const openContextMenu = (event) => {
    if (!result) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 166), y: Math.min(event.clientY, window.innerHeight - 52) });
  };

  return <main className="use-page">
    <header className="editor-topbar">
      <div className="editor-left"><IconButton label="返回模板库" onClick={onBack}><ArrowLeft size={21}/></IconButton><div className="title-field"><strong>{template.name}</strong><span>使用模板</span></div></div>
      <div className="editor-actions"><IconButton label="撤销 (Ctrl+Z)" onClick={undo} disabled={!canUndo}><Undo2 size={18}/></IconButton><button className="secondary-button" onClick={onEdit}><Pencil size={16}/>编辑模板</button></div>
    </header>
    <div className="use-layout">
      <section className="use-sidebar">
        <p className="eyebrow">第 1 步</p><h1>替换照片</h1><p className="use-intro">点击画布中的高亮区域，或把图片直接拖入对应区域。</p>
        <div className="slot-list-heading"><strong>可替换图层</strong><span>{slots.length}</span></div>
        <div className="slot-list">
          {slots.map((layer) => {
            const source = slotSources[layer.id];
            const name = slotNames[layer.id];
            return <button key={layer.id} type="button" className={`slot-item ${selectedId === layer.id ? 'selected' : ''}`} onClick={() => { setSelectedId(layer.id); requestSlotImage(layer.id); }}>
              <span className={`slot-item-thumb ${source ? 'has-image' : ''}`}>{source ? <img src={source} alt=""/> : <LayerThumb layer={layer}/>}</span>
              <span className="slot-item-copy"><strong>{layer.name}</strong><small>{name || '点击选择图片'}</small></span>
              {source ? <RotateCcw size={16}/> : <ImagePlus size={16}/>}
            </button>;
          })}
        </div>
        <input ref={input} hidden type="file" accept="image/*" onChange={(event) => { if (event.target.files[0]) acceptFile(event.target.files[0], pendingSlot.current); event.target.value = ''; pendingSlot.current = null; }}/>
        <div className="tip-box"><Clipboard size={19}/><p><strong>{autoCopy ? '自动复制已开启' : '自动复制已关闭'}</strong><span>{autoCopy ? '生成后可在聊天窗口或文件夹中粘贴。' : '生成后请点击“复制图片”。'}</span></p></div>
      </section>
      <section className="result-area">
        <div className="result-heading"><div><p className="eyebrow">第 2 步</p><h2>生成结果</h2></div><div className="result-heading-actions"><div className="zoom-control"><IconButton label="缩小" onClick={() => setZoom((current) => current - .1)}><ZoomOut size={17}/></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton label="放大" onClick={() => setZoom((current) => current + .1)}><ZoomIn size={17}/></IconButton></div>{result && <div className="result-actions"><button className="secondary-button" onClick={save}><Download size={17}/>保存 PNG</button><button className="primary-button" onClick={copyAgain}>{copied ? <Check size={17}/> : <Copy size={17}/>}复制图片</button></div>}</div></div>
        <div className="result-stage has-result" onWheel={zoomAtPointer} onContextMenu={openContextMenu} onDragStart={(event) => event.preventDefault()} onDragOver={(event) => { if (Array.from(event.dataTransfer.types || []).includes('Files')) event.preventDefault(); }} onDrop={dropOnSlot}>
          <UseStage composition={composition} slotSources={slotSources} selectedId={selectedId} setSelectedId={setSelectedId} updateLayer={updateLayer} onRequestSlot={requestSlotImage} zoom={zoom} pan={pan} panning={panning} onPanStart={beginPan}/>
          {working && <div className="generating result-overlay"><Sparkles size={30}/><strong>正在更新...</strong></div>}
        </div>
        {result && <div className={`copied-banner ${copied ? '' : 'copy-pending'}`}>{copied ? <Check size={18}/> : <Clipboard size={18}/>}<span>{copied ? '图片已复制，可粘贴到聊天窗口或文件夹' : '图片已生成，点击“复制图片”或保存 PNG'}</span></div>}
      </section>
    </div>
    {contextMenu && <div className="result-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button onClick={() => { setContextMenu(null); copyAgain(); }}><Copy size={16}/>复制图片</button></div>}
  </main>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
