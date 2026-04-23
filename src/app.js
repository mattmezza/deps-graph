/* global cytoscape, cytoscapeSvg */

// Register cytoscape-svg plugin if it's loaded.
if (typeof cytoscape !== 'undefined' && typeof cytoscapeSvg !== 'undefined') {
  try { cytoscape.use(cytoscapeSvg); } catch (_) { /* already registered */ }
}

// ---------- Lossless compression for URL params ----------
// Uses deflate-raw via CompressionStream → base64url encoding.
// Falls back to plain base64 on decode for backward compatibility.

async function compressStr(str) {
  const bytes = new TextEncoder().encode(str);
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  // base64url (no padding) for URL safety.
  return btoa(String.fromCharCode(...merged))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decompressStr(encoded) {
  // Try deflate-raw first, fall back to plain base64.
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return new TextDecoder().decode(
      chunks.reduce((acc, c) => {
        const merged = new Uint8Array(acc.length + c.length);
        merged.set(acc); merged.set(c, acc.length);
        return merged;
      }, new Uint8Array(0))
    );
  } catch (_) {
    // Fallback: plain base64 (old URLs).
    try { return atob(encoded); } catch (__) { return null; }
  }
}

function depManager() {
  const params = new URLSearchParams(window.location.search);
  const safeAtob = (v) => { try { return atob(v); } catch (e) { return null; } };

  return {
    tab: ['config', 'analysis', 'settings'].includes(params.get('tab')) ? params.get('tab') : 'config',
    querySet: '',
    queryResult: [],
    queryLabel: '',
    rootsResult: [],
    rootsLabel: '',
    edgeQuerySource: '',
    edgeQuerySink: '',
    edgeQueryResult: [],
    edgeQueryRan: false,
    impactSelectedEdge: '',
    impactResult: [],
    edgeList: [],
    nodeCount: 0,
    edgeCount: 0,
    showLabels: params.get('labels') === '1',
    filterBetweenSrc: '',
    filterBetweenSink: '',
    filterBetweenActive: false,
    cy: null,

    // Theme: 'system' | 'light' | 'dark'
    theme: localStorage.getItem('theme') || 'system',
    resolvedTheme: (() => {
      const t = localStorage.getItem('theme') || 'system';
      if (t === 'light') return 'light';
      if (t === 'dark') return 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    })(),

    // Header
    title: params.get('title') || 'My Graph',
    subtitle: params.get('subtitle') || 'Dependencies',

    // Theme
    mainColor: params.get('main') ? '#' + params.get('main') : '#4f46e5',
    accentColor: params.get('accent') ? '#' + params.get('accent') : '#f59e0b',
    edgeColor: params.get('edge') ? '#' + params.get('edge') : '#94a3b8',
    mainTextColor: params.get('mainText') ? '#' + params.get('mainText') : '#ffffff',
    accentTextColor: params.get('accentText') ? '#' + params.get('accentText') : '#451a03',

    // Graph settings
    _configParam: params.get('config') || '',
    rawConfig: 'Auth-Login->API\nAPI-Query->Database\nFrontend-Request->API',
    nodeSize: parseInt(params.get('nodeSize')) || 35,
    fontFamily: params.get('font') || localStorage.getItem('fontFamily') || 'noto-sans',
    fontSize: parseInt(params.get('fontSize')) || parseInt(localStorage.getItem('fontSize')) || 12,
    nodeShape: (() => {
      const allowed = ['ellipse', 'rectangle', 'round-rectangle', 'diamond', 'hexagon', 'triangle'];
      const v = params.get('shape');
      return allowed.includes(v) ? v : 'ellipse';
    })(),
    curveDistance: parseInt(params.get('curve')) || 90,
    hubSpread: params.get('hub') !== null ? parseFloat(params.get('hub')) : 3,

    // Aside panel width (persisted to localStorage so it doesn't pollute
    // the shareable URL). Min/max keep it usable.
    asideWidth: (() => {
      const saved = parseInt(localStorage.getItem('asideWidth'));
      return Number.isFinite(saved) && saved >= 240 && saved <= 1200
        ? saved
        : Math.round(window.innerWidth * 0.4);
    })(),
    resizing: false,
    asideCollapsed: localStorage.getItem('asideCollapsed') === '1',
    isFullscreen: false,
    exportFormat: localStorage.getItem('exportFormat') || 'png',

    // Share options
    shareIncludeConfig: true,
    shareIncludeBasicConfig: true,
    shareIncludeEdgeColors: true,
    shareIncludeEdgeStyles: true,
    shareIncludeTheme: true,
    shareCopied: false,
    showInfo: false,
    searchQuery: '',
    searchResults: [],
    showBetweenOpen: false,
    loading: 0,

    // Edge color rules: [{attr, op:'is'|'contains', value, color}]
    _rulesParam: params.get('rules') || '',
    edgeRules: [],

    // Edge style rules: [{attr, op:'is'|'contains', value, style:'dashed'|'dotted'|...}]
    _styleRulesParam: params.get('styleRules') || '',
    edgeStyleRules: [],

    async init() {
      // Decompress URL params (supports both compressed and plain base64).
      if (this._configParam) {
        const decoded = await decompressStr(this._configParam);
        if (decoded) this.rawConfig = decoded;
      }
      if (this._rulesParam) {
        const decoded = await decompressStr(this._rulesParam);
        if (decoded) { try { this.edgeRules = JSON.parse(decoded) || []; } catch (_) {} }
      }
      if (this._styleRulesParam) {
        const decoded = await decompressStr(this._styleRulesParam);
        if (decoded) { try { this.edgeStyleRules = JSON.parse(decoded) || []; } catch (_) {} }
      }

      this.applyResolvedTheme();
      this.loadFontFamily();
      // Listen for system preference changes.
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyResolvedTheme());

      this.applyTheme();
      this.initGraph();
      this.parseAndRender();

      // Debounced helpers to keep the UI responsive while sliders / color
      // pickers / text inputs fire rapid changes.
      const debounce = (fn, ms) => {
        let t;
        return (...args) => {
          clearTimeout(t);
          t = setTimeout(() => fn.apply(this, args), ms);
        };
      };

      const dParseAndRender   = debounce(() => this.parseAndRender(), 350);
      const dRunLayout        = debounce(() => {
        this.loading++;
        setTimeout(() => {
          try { this.runLayout(); } finally { this.loading--; }
        }, 0);
      }, 250);
      const dRefreshGraphStyle = debounce(() => {
        this.loading++;
        setTimeout(() => {
          try { this.refreshGraphStyle(); } finally { this.loading--; }
        }, 0);
      }, 100);
      const dApplyTheme       = debounce(() => this.applyTheme(), 50);
      const dNodeSizeStyle    = debounce((v) => {
        this.loading++;
        setTimeout(() => {
          try {
            this.cy.style().selector('node').style({ width: v + 'px', height: v + 'px' }).update();
          } finally { this.loading--; }
        }, 0);
      }, 100);
      const dNodeShapeStyle   = debounce((v) => {
        this.loading++;
        setTimeout(() => {
          try {
            this.cy.style().selector('node').style({ shape: v }).update();
          } finally { this.loading--; }
        }, 0);
      }, 50);
      const dUpdateURL = (() => {
        const timers = {};
        return (k, v) => {
          clearTimeout(timers[k]);
          timers[k] = setTimeout(() => this.updateURL(k, v), 300);
        };
      })();

      // Sync URL with state. URL writes are always debounced; expensive
      // graph operations are debounced too. Cheap DOM-only updates (title,
      // subtitle, theme CSS variables) stay immediate for snappy feedback.
      this.$watch('rawConfig',     (v) => { compressStr(v).then((c) => this.updateURL('config', c)); dParseAndRender(); });
      this.$watch('title',         (v) => dUpdateURL('title', v));
      this.$watch('subtitle',      (v) => dUpdateURL('subtitle', v));
      this.$watch('mainColor',     (v) => { dUpdateURL('main',   v.replace('#', '')); dApplyTheme(); dRefreshGraphStyle(); });
      this.$watch('accentColor',   (v) => { dUpdateURL('accent', v.replace('#', '')); dApplyTheme(); dRefreshGraphStyle(); });
      this.$watch('edgeColor',     (v) => { dUpdateURL('edge',   v.replace('#', '')); dRefreshGraphStyle(); });
      this.$watch('mainTextColor', (v) => { dUpdateURL('mainText', v.replace('#', '')); dApplyTheme(); });
      this.$watch('accentTextColor', (v) => { dUpdateURL('accentText', v.replace('#', '')); dApplyTheme(); });
      this.$watch('nodeSize',      (v) => { dUpdateURL('nodeSize', v); dNodeSizeStyle(v); });
      this.$watch('nodeShape',     (v) => { dUpdateURL('shape', v); dNodeShapeStyle(v); });
      this.$watch('fontFamily',    (v) => { localStorage.setItem('fontFamily', v); dUpdateURL('font', v); this.loadFontFamily(); });
      this.$watch('fontSize',      (v) => { localStorage.setItem('fontSize', v); dUpdateURL('fontSize', v); dRefreshGraphStyle(); });
      this.$watch('curveDistance', (v) => { dUpdateURL('curve', v); dParseAndRender(); });
      this.$watch('hubSpread',     (v) => { dUpdateURL('hub',   v); dRunLayout(); });
      this.$watch('exportFormat',  (v) => { localStorage.setItem('exportFormat', v); });
      this.$watch('tab',           (v) => dUpdateURL('tab', v === 'config' ? '' : v));
      this.$watch('showLabels',    (v) => dUpdateURL('labels', v ? '1' : ''));

      const dSearch = debounce(() => this.doSearch(), 150);
      this.$watch('searchQuery', () => dSearch());
      window.addEventListener('popstate', async () => {
        const p = new URLSearchParams(window.location.search);
        const cfg = p.get('config');
        if (cfg) {
          const decoded = await decompressStr(cfg);
          if (decoded) this.rawConfig = decoded;
        }
      });

      this.cy.on('mouseover', 'edge', (e) => e.target.addClass('hover'));
      this.cy.on('mouseout',  'edge', (e) => e.target.removeClass('hover'));

      this.$watch('showLabels', (val) => {
        if (val) this.cy.edges().addClass('visible-labels');
        else this.cy.edges().removeClass('visible-labels');
      });
    },

    updateURL(key, value) {
      const url = new URL(window.location);
      if (value === '' || value === null || value === undefined) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
      window.history.replaceState({}, '', url);
    },

    applyTheme() {
      const root = document.documentElement;
      root.style.setProperty('--theme-main', this.mainColor);
      root.style.setProperty('--theme-accent', this.accentColor);
      root.style.setProperty('--theme-main-text', this.mainTextColor);
      root.style.setProperty('--theme-accent-text', this.accentTextColor);
    },

    applyResolvedTheme() {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      this.resolvedTheme = this.theme === 'system'
        ? (prefersDark ? 'dark' : 'light')
        : this.theme;
      document.documentElement.classList.toggle('dark', this.resolvedTheme === 'dark');
      // Update Cytoscape canvas colors if graph exists.
      if (this.cy) {
        this.updateCyThemeColors();
      }
    },

    cycleTheme() {
      const order = ['system', 'light', 'dark'];
      const idx = order.indexOf(this.theme);
      this.theme = order[(idx + 1) % order.length];
      localStorage.setItem('theme', this.theme);
      this.applyResolvedTheme();
    },

    updateCyThemeColors() {
      const styles = getComputedStyle(document.documentElement);
      const cyBg = styles.getPropertyValue('--cy-bg').trim();
      const labelBg = styles.getPropertyValue('--edge-label-bg').trim();
      const labelBorder = styles.getPropertyValue('--edge-label-border').trim();
      const labelColor = styles.getPropertyValue('--edge-label-color').trim();
      const nodeColor = styles.getPropertyValue('--node-label-color').trim();
      const surfaceText = styles.getPropertyValue('--surface-text').trim();

      this.cy.container().style.background = cyBg;
      this.cy.style()
        .selector('node').style({
          'color': nodeColor,
        })
        .selector('edge').style({
          'color': labelColor,
          'text-background-color': labelBg,
          'text-border-color': labelBorder,
        })
        .update();
    },

    // ---------- aside resize ----------
    toggleAside() {
      this.asideCollapsed = !this.asideCollapsed;
      localStorage.setItem('asideCollapsed', this.asideCollapsed ? '1' : '0');
      // Let DOM apply the layout change before resizing the canvas.
      requestAnimationFrame(() => { if (this.cy) this.cy.resize(); });
    },

    toggleFullscreen() {
      const el = document.documentElement;
      if (!document.fullscreenElement) {
        (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
      }
    },

    startAsideResize(ev) {
      this.resizing = true;
      const startX = ev.clientX;
      const startW = this.asideWidth;
      const minW = 240;
      const maxW = Math.max(minW, window.innerWidth - 200);
      const handle = ev.currentTarget;
      const pointerId = ev.pointerId;

      // Capture the pointer so we keep getting moves even when the cursor
      // is over the Cytoscape canvas (which otherwise swallows them).
      if (handle && pointerId != null && handle.setPointerCapture) {
        try { handle.setPointerCapture(pointerId); } catch (_) {}
      }

      const onMove = (e) => {
        const w = Math.min(maxW, Math.max(minW, startW + (e.clientX - startX)));
        this.asideWidth = w;
        if (this.cy) this.cy.resize();
      };
      const onUp = () => {
        this.resizing = false;
        localStorage.setItem('asideWidth', String(this.asideWidth));
        if (handle) {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
          if (pointerId != null && handle.releasePointerCapture) {
            try { handle.releasePointerCapture(pointerId); } catch (_) {}
          }
        }
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        if (this.cy) this.cy.resize();
      };

      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      if (handle) {
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      }
    },

    resetColors() {
      this.applyPreset(this.colorPresets[0]);
    },

    colorPresets: [
      { name: 'Indigo',    main: '#4f46e5', accent: '#f59e0b', edge: '#94a3b8', mainText: '#ffffff', accentText: '#451a03' },
      { name: 'Ocean',     main: '#0e7490', accent: '#fbbf24', edge: '#6b7280', mainText: '#ffffff', accentText: '#422006' },
      { name: 'Forest',    main: '#166534', accent: '#facc15', edge: '#78716c', mainText: '#ffffff', accentText: '#3f3f46' },
      { name: 'Rose',      main: '#be123c', accent: '#fde68a', edge: '#a1a1aa', mainText: '#ffffff', accentText: '#881337' },
      { name: 'Slate',     main: '#334155', accent: '#38bdf8', edge: '#9ca3af', mainText: '#f1f5f9', accentText: '#0c4a6e' },
      { name: 'Lavender',  main: '#7c3aed', accent: '#a3e635', edge: '#a78bfa', mainText: '#ffffff', accentText: '#1a2e05' },
      { name: 'Mono',      main: '#18181b', accent: '#e4e4e7', edge: '#71717a', mainText: '#fafafa', accentText: '#18181b' },
    ],

    fontFamilyCss() {
      const font = this.bunnyFonts.find(f => f.slug === this.fontFamily) || this.bunnyFonts[0];
      return `"${font.name}", sans-serif`;
    },

    loadFontFamily() {
      const font = this.bunnyFonts.find(f => f.slug === this.fontFamily) || this.bunnyFonts[0];
      const existing = document.getElementById('dynamic-font');
      if (existing) existing.remove();
      const link = document.createElement('link');
      link.id = 'dynamic-font';
      link.rel = 'stylesheet';
      link.href = `https://fonts.bunny.net/css?family=${encodeURIComponent(font.slug)}:400,700`;
      document.head.appendChild(link);
      document.documentElement.style.setProperty('--graph-font', this.fontFamilyCss());
      if (this.cy) {
        this.loading++;
        setTimeout(() => {
          try {
            this.cy.style()
              .selector('node').style({ 'font-family': this.fontFamilyCss() })
              .selector('edge').style({ 'font-family': this.fontFamilyCss() })
              .update();
          } finally {
            this.loading--;
          }
        }, 0);
      }
    },

    bunnyFonts: [
      { name: 'Noto Sans', slug: 'noto-sans' },
      { name: 'Inter', slug: 'inter' },
      { name: 'Roboto', slug: 'roboto' },
      { name: 'Open Sans', slug: 'open-sans' },
      { name: 'Lato', slug: 'lato' },
      { name: 'Fira Sans', slug: 'fira-sans' },
      { name: 'Source Sans 3', slug: 'source-sans-3' },
      { name: 'Nunito', slug: 'nunito' },
      { name: 'Poppins', slug: 'poppins' },
      { name: 'Ubuntu', slug: 'ubuntu' },
      { name: 'Playfair Display', slug: 'playfair-display' },
      { name: 'Merriweather', slug: 'merriweather' },
      { name: 'JetBrains Mono', slug: 'jetbrains-mono' },
      { name: 'IBM Plex Mono', slug: 'ibm-plex-mono' },
    ],

    applyPreset(preset) {
      this.mainColor = preset.main;
      this.accentColor = preset.accent;
      this.edgeColor = preset.edge;
      this.mainTextColor = preset.mainText;
      this.accentTextColor = preset.accentText;
    },

    // Re-apply graph styles whose colors are theme-dependent
    refreshGraphStyle() {
      if (!this.cy) return;
      this.cy.style()
        .selector('node').style({
          'background-color': this.mainColor,
          'border-color': this.accentColor,
          'font-size': this.fontSize + 'px',
          'font-family': this.fontFamilyCss(),
        })
        .selector('edge').style({
          'line-color': this.edgeColor,
          'target-arrow-color': this.edgeColor,
          'font-size': Math.max(8, this.fontSize - 2) + 'px',
          'font-family': this.fontFamilyCss(),
        })
        .selector('edge.hover').style({
          'line-color': this.accentColor,
          'target-arrow-color': this.accentColor,
        })
        .selector('edge:selected').style({
          'line-color': this.accentColor,
          'target-arrow-color': this.accentColor,
        })
        .update();
      this.applyEdgeRules();
    },

    // ---------- Edge color rules ----------
    addEdgeRule() {
      this.edgeRules.push({ attr: '', op: 'is', value: '', color: this.accentColor });
      this.persistEdgeRules();
      this.applyEdgeRules();
    },
    removeEdgeRule(idx) {
      this.edgeRules.splice(idx, 1);
      this.persistEdgeRules();
      this.applyEdgeRules();
    },
    persistEdgeRules() {
      if (!this.edgeRules.length) this.updateURL('rules', '');
      else compressStr(JSON.stringify(this.edgeRules)).then((c) => this.updateURL('rules', c));
    },
    evalEdgeRule(attrs, rule) {
      if (!rule.attr) return false;
      const v = attrs[rule.attr];
      if (v === undefined || v === null) return false;
      const sv = String(v);
      if (rule.op === 'contains') return sv.toLowerCase().includes(String(rule.value).toLowerCase());
      return sv === String(rule.value);
    },
    colorForEdge(attrs) {
      for (const rule of this.edgeRules) {
        if (this.evalEdgeRule(attrs, rule)) return rule.color;
      }
      return null;
    },
    applyEdgeRules() {
      if (!this.cy) return;
      this.persistEdgeRules();
      this.cy.edges().forEach((e) => {
        const color = this.colorForEdge(e.data('attrs') || {});
        if (color) {
          e.style('line-color', color);
          e.style('target-arrow-color', color);
        } else {
          e.removeStyle('line-color');
          e.removeStyle('target-arrow-color');
        }
      });
    },

    // ---------- edge style rules (line dash pattern) ----------
    // Style options map to Cytoscape line-style + line-dash-pattern values.
    edgeStyleOptions: [
      { value: 'solid',         label: 'Solid' },
      { value: 'dotted',        label: 'Dotted' },
      { value: 'short-dash',    label: 'Short Dash' },
      { value: 'medium-dash',   label: 'Medium Dash' },
      { value: 'long-dash',     label: 'Long Dash' },
      { value: 'dash-dot',      label: 'Dash-Dot' },
    ],

    edgeStylePatterns: {
      'solid':       { lineStyle: 'solid', pattern: null },
      'dotted':      { lineStyle: 'dotted', pattern: null },
      'short-dash':  { lineStyle: 'dashed', pattern: [4, 4] },
      'medium-dash': { lineStyle: 'dashed', pattern: [10, 6] },
      'long-dash':   { lineStyle: 'dashed', pattern: [20, 8] },
      'dash-dot':    { lineStyle: 'dashed', pattern: [12, 4, 2, 4] },
    },

    addEdgeStyleRule() {
      this.edgeStyleRules.push({ attr: '', op: 'is', value: '', style: 'short-dash' });
      this.persistEdgeStyleRules();
      this.applyEdgeStyleRules();
    },
    removeEdgeStyleRule(idx) {
      this.edgeStyleRules.splice(idx, 1);
      this.persistEdgeStyleRules();
      this.applyEdgeStyleRules();
    },
    persistEdgeStyleRules() {
      if (!this.edgeStyleRules.length) this.updateURL('styleRules', '');
      else compressStr(JSON.stringify(this.edgeStyleRules)).then((c) => this.updateURL('styleRules', c));
    },
    styleForEdge(attrs) {
      for (const rule of this.edgeStyleRules) {
        if (this.evalEdgeRule(attrs, rule)) return rule.style;
      }
      return null;
    },
    applyEdgeStyleRules() {
      if (!this.cy) return;
      this.persistEdgeStyleRules();
      this.cy.edges().forEach((e) => {
        const styleName = this.styleForEdge(e.data('attrs') || {});
        if (styleName && this.edgeStylePatterns[styleName]) {
          const sp = this.edgeStylePatterns[styleName];
          e.style('line-style', sp.lineStyle);
          if (sp.pattern) {
            e.style('line-dash-pattern', sp.pattern);
          } else {
            e.removeStyle('line-dash-pattern');
          }
        } else {
          e.removeStyle('line-style');
          e.removeStyle('line-dash-pattern');
        }
      });
    },

    initGraph() {
      const styles = getComputedStyle(document.documentElement);
      const labelBg = styles.getPropertyValue('--edge-label-bg').trim() || '#111827';
      const labelBorder = styles.getPropertyValue('--edge-label-border').trim() || '#374151';
      const labelColor = styles.getPropertyValue('--edge-label-color').trim() || '#f9fafb';
      const nodeColor = styles.getPropertyValue('--node-label-color').trim() || '#ffffff';

      this.cy = cytoscape({
        container: document.getElementById('cy'),
        // Lower = finer zoom steps per wheel notch (default is 1).
        wheelSensitivity: 0.2,
        style: [
          {
            selector: 'node',
            style: {
              color: nodeColor,
              shape: this.nodeShape,
              'border-width': 2,
              'border-color': this.accentColor,
              'background-color': this.mainColor,
              label: 'data(id)',
              'font-weight': 'bold',
              'font-size': this.fontSize + 'px',
              'font-family': this.fontFamilyCss(),
              'text-valign': 'center',
              'text-halign': 'center',
              width: this.nodeSize + 'px',
              height: this.nodeSize + 'px',
            },
          },
          {
            selector: 'edge',
            style: {
              width: 2,
              'line-color': this.edgeColor,
              'target-arrow-color': this.edgeColor,
              'target-arrow-shape': 'triangle',
              label: '',
              'curve-style': 'unbundled-bezier',
              'control-point-weights': (edge) => edge.data('curveWeight') ?? 0.5,
              'control-point-distances': (edge) => edge.data('curveDistance') || 0,
              color: labelColor,
              'font-size': Math.max(8, this.fontSize - 2) + 'px',
              'font-family': this.fontFamilyCss(),
              'text-wrap': 'wrap',
              'text-background-opacity': 1,
              'text-background-color': labelBg,
              'text-background-padding': '3px',
              'text-background-shape': 'roundrectangle',
              'text-border-opacity': 1,
              'text-border-color': labelBorder,
              'text-border-width': 1,
              'text-rotation': 'autorotate',
            },
          },
          {
            // Showing all labels: only show the label, no color/width change.
            selector: 'edge.visible-labels',
            style: {
              label: 'data(fullLabel)',
            },
          },
          {
            // Hovering an edge: highlight + show the label.
            selector: 'edge.hover',
            style: {
              label: 'data(fullLabel)',
              width: 4,
              'line-color': this.accentColor,
              'target-arrow-color': this.accentColor,
              'z-index': 999,
            },
          },
          {
            selector: 'edge:selected',
            style: {
              width: 5,
              'line-color': this.accentColor,
              'target-arrow-color': this.accentColor,
            },
          },
          {
            // Programmatic highlight from analysis panel hover.
            selector: 'node.hl',
            style: {
              'border-width': 6,
              'border-color': this.accentColor,
              'z-index': 999,
            },
          },
          {
            selector: 'edge.hl',
            style: {
              label: 'data(fullLabel)',
              width: 5,
              'line-color': this.accentColor,
              'target-arrow-color': this.accentColor,
              'z-index': 999,
            },
          },
          {
            selector: '.filtered-out',
            style: {
              opacity: 0.08,
              'events': 'no',
            },
          },
        ],
        layout: { name: 'preset' },
      });
    },

    parseConfig() {
      const lines = this.rawConfig.split('\n');
      // Match: <src> -...- <label> -...-> <target> [optional trailing attrs]
      // src/label/target may be optionally double-quoted (quoted strings can contain spaces/dashes)
      const regex = /^\s*(?:"([^"]+)"|([^\s"-][^\s-]*))\s*-+\s*(?:"([^"]+)"|([^\s"-][^\s-]*))\s*-+>\s*(?:"([^"]+)"|(\S+))\s*(.*)$/;

      return lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return { type: 'blank' };
        if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
          return { type: 'comment', comment: line };
        }
        const match = trimmed.match(regex);
        if (match) {
          const src = (match[1] ?? match[2]).trim();
          const label = (match[3] ?? match[4]).trim();
          const target = (match[5] ?? match[6]).trim();
          const attrsRaw = (match[7] || '').trim();
          const attrs = this.parseAttributes(attrsRaw);
          return { type: 'adjacency', src, label, target, attrs, attrsRaw };
        }
        return null;
      }).filter(Boolean);
    },

    // Parse `key=value` pairs, supporting quoted keys/values:
    //   done=false prio=4 "done on"="2026-01-01 09:00" prio=high
    parseAttributes(str) {
      const attrs = {};
      if (!str) return attrs;
      const re = /(?:"([^"]+)"|([^\s="]+))\s*=\s*(?:"([^"]*)"|(\S+))/g;
      let m;
      while ((m = re.exec(str)) !== null) {
        const key = m[1] ?? m[2];
        const val = m[3] ?? m[4];
        attrs[key] = val;
      }
      return attrs;
    },

    parseAndRender() {
      this.loading++;
      setTimeout(() => {
        try {
          const data = this.parseConfig();
          const adjacencies = data.filter((item) => item.type === 'adjacency');

          // Structural fingerprint: only rebuild+layout when edges/nodes/attrs change.
          const fingerprint = adjacencies.map((a) =>
            `${a.src}\t${a.label}\t${a.target}\t${a.attrsRaw}`
          ).join('\n') + '\n_curve=' + this.curveDistance;
          if (fingerprint === this._lastFingerprint) {
            return;
          }
          this._lastFingerprint = fingerprint;

          const elements = [];
          const nodesSet = new Set();
          const edgesData = [];
          const edgeCounts = {};

          adjacencies.forEach((item, i) => {
            nodesSet.add(item.src);
            nodesSet.add(item.target);

            const pairId = [item.src, item.target].sort().join('-');
            edgeCounts[pairId] = (edgeCounts[pairId] || 0) + 1;
            const count = edgeCounts[pairId];
            // Perpendicular offset: alternate sides, growing magnitude per pair.
            const distance = (count % 2 === 0 ? 1 : -1) * (Math.ceil(count / 2) * parseInt(this.curveDistance));
            // Stagger label position along the edge so multiple parallel labels
            // don't pile up at the midpoint. Spreads weights around 0.5 in steps.
            const step = 0.08;
            const weight = 0.5 + (count % 2 === 0 ? 1 : -1) * Math.ceil(count / 2) * step;

            edgesData.push({
              group: 'edges',
              data: {
                id: `e-${i}`,
                source: item.src,
                target: item.target,
                label: item.label,
                attrs: item.attrs || {},
                fullLabel: this.buildEdgeLabel(item),
                curveDistance: distance,
                curveWeight: Math.max(0.15, Math.min(0.85, weight)),
              },
            });
          });

          // Save current node positions before rebuilding.
          const savedPositions = {};
          if (this.cy) {
            this.cy.nodes().forEach((n) => {
              const pos = n.position();
              savedPositions[n.id()] = { x: pos.x, y: pos.y };
            });
          }

          nodesSet.forEach((nodeId) => {
            elements.push({ group: 'nodes', data: { id: nodeId } });
          });
          elements.push(...edgesData);

          this.cy.elements().remove();
          this.cy.add(elements);

          // Restore saved positions for existing nodes.
          let hasNewNodes = false;
          const newNodeIds = [];
          this.cy.nodes().forEach((n) => {
            const saved = savedPositions[n.id()];
            if (saved) {
              n.position(saved);
            } else {
              hasNewNodes = true;
              newNodeIds.push(n.id());
            }
          });

          // Only run layout if there are new nodes without positions.
          if (hasNewNodes || !Object.keys(savedPositions).length) {
            this.runLayout({ newNodeIds });
          }
          this.applyEdgeRules();
          this.applyEdgeStyleRules();
          this.buildEdgeList();
          this.nodeCount = this.cy.nodes().length;
          this.edgeCount = this.cy.edges().length;
        } catch (e) {
          console.error(e);
        } finally {
          this.loading--;
        }
      }, 0);
    },

    repositionNodes() {
      if (!this.cy) return;
      this.loading++;
      setTimeout(() => {
        try {
          this.runLayout({ initializeAll: true });
        } finally {
          this.loading--;
        }
      }, 0);
    },

    // Layout that pushes high-degree (hub) nodes further apart.
    //
    // Implementation notes:
    //  - cose's default `fit: true` rescales the whole graph to the viewport
    //    *after* layout, which means cranking up nodeRepulsion makes the
    //    graph internally larger but visually the same size -- hubs end up
    //    *closer* together on screen. We grow `boundingBox` linearly with
    //    spread instead, so cose has more room to actually separate hubs
    //    and the post-layout fit doesn't squash the result.
    //  - We also use deterministic initial positions based on node ID hashes
    //    so the layout is reproducible across renders.
    runLayout(options = {}) {
      if (!this.cy) return;
      const spread = parseFloat(this.hubSpread);
      const s = isFinite(spread) ? Math.max(0, spread) : 0;
      const n = Math.max(1, this.cy.nodes().length);

      // Base canvas size scales with node count; spread multiplies it.
      const baseSide = 800 + n * 80;
      const side = baseSide * (1 + s * 0.8);

      // Deterministic hash for initial positions (avoids random layout on every render).
      const hashStr = (str) => {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
          h = ((h << 5) - h + str.charCodeAt(i)) | 0;
        }
        return h;
      };

      const initNode = (node) => {
        const h = hashStr(node.id());
        const x = ((h & 0xFFFF) / 0xFFFF) * side;
        const y = (((h >>> 16) & 0xFFFF) / 0xFFFF) * side;
        node.position({ x, y });
      };

      if (options.initializeAll) {
        this.cy.nodes().forEach(initNode);
      } else if (options.newNodeIds && options.newNodeIds.length > 0) {
        options.newNodeIds.forEach((id) => {
          const node = this.cy.getElementById(id);
          if (!node.empty()) initNode(node);
        });
      }

      // Per-node repulsion: hubs get exponentially more repulsion than leaves.
      const repulsion = (node) => {
        const deg = Math.max(1, node.degree());
        // s=0 -> all 16384; s=3 -> deg^2.1 multiplier; s=10 -> deg^7
        return 16384 * Math.pow(deg, 0.7 * Math.max(0.5, s));
      };

      // Edge length grows with combined endpoint degree (so hub-hub edges
      // are longer than leaf-leaf), and overall scale grows with spread.
      const edgeLen = (edge) => {
        const d = Math.max(2, edge.source().degree() + edge.target().degree());
        return 100 * (1 + s * 0.6) * Math.pow(d / 2, 0.5 * Math.max(0.5, s));
      };

      this.cy.layout({
        name: 'cose',
        animate: false,
        fit: true,
        padding: 40,
        randomize: false,
        boundingBox: { x1: 0, y1: 0, w: side, h: side },
        componentSpacing: 100 + s * 100,
        nodeRepulsion: repulsion,
        idealEdgeLength: edgeLen,
        edgeElasticity: 50,
        gravity: Math.max(0.05, 0.4 - s * 0.05),
        nestingFactor: 1.2,
        numIter: 2500,
        initialTemp: 1500,
        coolingFactor: 0.97,
        minTemp: 1.0,
      }).run();
      this.spreadHubs();
      this.removeNodeOverlaps();
    },

    spreadHubs(maxIter = 100) {
      if (!this.cy) return;
      const size = parseFloat(this.nodeSize) || 35;
      const nodes = this.cy.nodes();
      const len = nodes.length;
      for (let iter = 0; iter < maxIter; iter++) {
        let moved = false;
        for (let i = 0; i < len; i++) {
          const n1 = nodes[i];
          const deg1 = n1.degree();
          for (let j = i + 1; j < len; j++) {
            const n2 = nodes[j];
            const deg2 = n2.degree();
            const totalDeg = deg1 + deg2;
            if (totalDeg < 4) continue; // low-degree pairs need no extra room
            const dx = n2.position('x') - n1.position('x');
            const dy = n2.position('y') - n1.position('y');
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            // Minimum distance scales with combined degree so hubs get plenty of clearance.
            const minDist = size + 40 + totalDeg * 8;
            if (dist < minDist) {
              const push = (minDist - dist) * 0.35;
              const nx = dx / dist;
              const ny = dy / dist;
              n1.shift({ x: -nx * push, y: -ny * push });
              n2.shift({ x: nx * push, y: ny * push });
              moved = true;
            }
          }
        }
        if (!moved) break;
      }
    },

    removeNodeOverlaps(padding = 15, maxIter = 100) {
      if (!this.cy) return;
      const size = parseFloat(this.nodeSize) || 35;
      const minDist = size + padding;
      const nodes = this.cy.nodes();
      const len = nodes.length;
      for (let iter = 0; iter < maxIter; iter++) {
        let moved = false;
        for (let i = 0; i < len; i++) {
          const n1 = nodes[i];
          for (let j = i + 1; j < len; j++) {
            const n2 = nodes[j];
            const dx = n2.position('x') - n1.position('x');
            const dy = n2.position('y') - n1.position('y');
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dist < minDist) {
              const overlap = (minDist - dist) / 2;
              const nx = dx / dist;
              const ny = dy / dist;
              n1.shift({ x: -nx * overlap, y: -ny * overlap });
              n2.shift({ x: nx * overlap, y: ny * overlap });
              moved = true;
            }
          }
        }
        if (!moved) break;
      }
    },

    formatConfig() {
      this.loading++;
      setTimeout(() => {
        try {
          const data = this.parseConfig();
          if (!data.length) return;

          const adjacencies = data.filter((d) => d.type === 'adjacency');
          const maxSrc = Math.max(...adjacencies.map((d) => d.src.length), 0);
          const maxLabel = Math.max(...adjacencies.map((d) => d.label.length), 0);

          this.rawConfig = data.map((item) => {
            if (item.type === 'blank') return '';
            if (item.type === 'comment') return item.comment;

            const srcPart = `"${item.src}"`.padEnd(maxSrc + 2, '-');
            const labelText = `"${item.label}"`;
            const totalLabelWidth = maxLabel + 6;
            const labelPart = labelText
              .padStart((totalLabelWidth + labelText.length) / 2, '-')
              .padEnd(totalLabelWidth, '-');

            const tail = item.attrsRaw ? ` ${item.attrsRaw}` : '';
            return `${srcPart}---${labelPart}-->"${item.target}"${tail}`;
          }).join('\n');
        } finally {
          this.loading--;
        }
      }, 0);
    },

    // Build a multi-line label for an edge: label + key=value pairs
    buildEdgeLabel(item) {
      const parts = [item.label];
      if (item.attrs) {
        for (const [k, v] of Object.entries(item.attrs)) {
          parts.push(`${k}=${v}`);
        }
      }
      return parts.join('\n');
    },

    // ---------- analysis ----------
    // Edge semantics: `A-rel->B` means "A depends on B" (edge A→B).
    //   Upstream of N   = what N depends on (transitively) = successors(N)
    //   Downstream of N = what depends on N (transitively) = predecessors(N)

    parseQueryNodes() {
      return this.querySet.split(',').map((s) => s.trim()).filter(Boolean);
    },

    getUpstream() {
      if (!this.cy) return;
      const targets = this.parseQueryNodes();
      const result = new Set();
      targets.forEach((t) => {
        const node = this.cy.getElementById(t);
        if (node.empty()) return;
        node.successors('node').forEach((n) => result.add(n.id()));
      });
      targets.forEach((t) => result.delete(t));
      this.queryResult = Array.from(result);
      this.queryLabel = `Upstream of ${targets.join(', ')}`;
    },

    getDownstream() {
      if (!this.cy) return;
      const targets = this.parseQueryNodes();
      const result = new Set();
      targets.forEach((t) => {
        const node = this.cy.getElementById(t);
        if (node.empty()) return;
        node.predecessors('node').forEach((n) => result.add(n.id()));
      });
      targets.forEach((t) => result.delete(t));
      this.queryResult = Array.from(result);
      this.queryLabel = `Downstream of ${targets.join(', ')}`;
    },

    computeRoots() {
      // No upstream deps = node depends on nothing = no outgoing edges.
      if (!this.cy) return;
      this.rootsResult = this.cy.nodes()
        .filter((n) => n.outdegree() === 0)
        .map((n) => n.id());
      this.rootsLabel = 'Nodes with 0 upstream';
    },

    computeLeaves() {
      // No downstream deps = nothing depends on the node = no incoming edges.
      if (!this.cy) return;
      this.rootsResult = this.cy.nodes()
        .filter((n) => n.indegree() === 0)
        .map((n) => n.id());
      this.rootsLabel = 'Nodes with 0 downstream';
    },

    queryEdges() {
      this.edgeQueryRan = true;
      this.edgeQueryResult = [];
      if (!this.cy) return;
      const src = this.edgeQuerySource.trim();
      const sink = this.edgeQuerySink.trim();
      if (!src || !sink) return;
      const srcNode = this.cy.getElementById(src);
      const sinkNode = this.cy.getElementById(sink);
      if (srcNode.empty() || sinkNode.empty()) return;

      // Edges on any directed path src -> ... -> sink:
      // intersection of (edges reachable forward from src) and
      // (edges reachable backward from sink).
      const forwardEdges = srcNode.successors('edge');
      const backwardEdges = sinkNode.predecessors('edge');
      const pathEdges = forwardEdges.intersection(backwardEdges);

      this.edgeQueryResult = pathEdges.map((e) => {
        const attrs = e.data('attrs') || {};
        const ruleColor = this.colorForEdge(attrs);
        return {
          id: e.id(),
          source: e.data('source'),
          target: e.data('target'),
          label: e.data('label'),
          attrs,
          color: ruleColor || this.edgeColor,
        };
      });
    },

    // ---------- highlight ----------
    highlightNodes(ids) {
      if (!this.cy) return;
      this.cy.elements().removeClass('hl');
      ids.forEach((id) => {
        const n = this.cy.getElementById(id);
        if (!n.empty()) n.addClass('hl');
      });
    },

    highlightEdges(ids) {
      if (!this.cy) return;
      this.cy.elements().removeClass('hl');
      ids.forEach((id) => {
        const e = this.cy.getElementById(id);
        if (!e.empty()) {
          e.addClass('hl');
          e.connectedNodes().addClass('hl');
        }
      });
    },

    clearHighlight() {
      if (!this.cy) return;
      this.cy.elements().removeClass('hl');
    },

    applyFilterBetween() {
      if (!this.cy) return;
      const src = this.filterBetweenSrc.trim();
      const sink = this.filterBetweenSink.trim();
      if (!src || !sink) {
        this.clearFilterBetween();
        return;
      }
      const srcNode = this.cy.getElementById(src);
      const sinkNode = this.cy.getElementById(sink);
      if (srcNode.empty() || sinkNode.empty()) {
        this.clearFilterBetween();
        return;
      }
      // Elements on any path from src to sink.
      const forward = srcNode.union(srcNode.successors());
      const backward = sinkNode.union(sinkNode.predecessors());
      const between = forward.intersection(backward);
      this.cy.elements().addClass('filtered-out');
      between.removeClass('filtered-out');
      this.filterBetweenActive = true;
    },

    clearFilterBetween() {
      if (!this.cy) return;
      this.cy.elements().removeClass('filtered-out');
      this.filterBetweenActive = false;
    },

    // ---------- impact analysis ----------
    buildEdgeList() {
      if (!this.cy) { this.edgeList = []; return; }
      this.edgeList = this.cy.edges().map((e) => ({
        id: e.id(),
        label: e.data('label'),
        source: e.data('source'),
        target: e.data('target'),
        display: `${e.data('source')}-${e.data('label')}->${e.data('target')}`,
      }));
    },

    doSearch() {
      const q = (this.searchQuery || '').toLowerCase().trim();
      if (!q || !this.cy) { this.searchResults = []; return; }
      const results = [];
      this.cy.nodes().forEach((n) => {
        if (n.id().toLowerCase().includes(q)) {
          results.push({ id: n.id(), type: 'node', label: n.id() });
        }
      });
      this.cy.edges().forEach((e) => {
        const full = `${e.data('source')}-${e.data('label')}->${e.data('target')}`.toLowerCase();
        if (full.includes(q)) {
          results.push({ id: e.id(), type: 'edge', label: e.data('source') + '-' + e.data('label') + '->' + e.data('target') });
        }
      });
      this.searchResults = results;
    },

    searchAction(r) {
      if (!this.cy) return;
      this.cy.elements().removeClass('hl');
      if (r.type === 'node') {
        const n = this.cy.getElementById(r.id);
        if (!n.empty()) {
          n.addClass('hl');
          this.cy.animate({ center: { eles: n }, zoom: 1.5 }, { duration: 400 });
        }
      } else {
        const e = this.cy.getElementById(r.id);
        if (!e.empty()) {
          e.addClass('hl');
          const nodes = e.connectedNodes();
          nodes.addClass('hl');
          this.cy.animate({ center: { eles: nodes.union(e) }, zoom: 1.5 }, { duration: 400 });
        }
      }
    },

    clearSearch() {
      this.searchQuery = '';
      this.searchResults = [];
      if (this.cy) this.cy.elements().removeClass('hl');
    },

    computeImpact() {
      if (!this.cy || !this.impactSelectedEdge) {
        this.impactResult = [];
        return;
      }
      const edge = this.cy.getElementById(this.impactSelectedEdge);
      if (edge.empty()) {
        this.impactResult = [];
        return;
      }
      // The source of the edge directly depends on the target.
      // BFS upstream from source: predecessors at each hop get increasing degree.
      const sourceId = edge.data('source');
      const result = []; // [{id, degree}]
      const visited = new Set();
      let frontier = [sourceId];
      let degree = 1;

      while (frontier.length) {
        const nextFrontier = [];
        for (const id of frontier) {
          if (visited.has(id)) continue;
          visited.add(id);
          result.push({ id, degree });
          // Find predecessors: nodes that depend on this node (incoming edges).
          const node = this.cy.getElementById(id);
          if (!node.empty()) {
            node.incomers('edge').forEach((e) => {
              const src = e.data('source');
              if (!visited.has(src)) nextFrontier.push(src);
            });
          }
        }
        degree++;
        frontier = nextFrontier;
      }

      this.impactResult = result;
    },

    zoomToNodes(ids) {
      if (!this.cy) return;
      const eles = this.cy.collection();
      ids.forEach((id) => {
        const n = this.cy.getElementById(id);
        if (!n.empty()) eles.merge(n);
      });
      if (eles.empty()) return;
      this.highlightNodes(ids);
      this.cy.animate({
        fit: { eles, padding: 80 },
        duration: 400,
        easing: 'ease-in-out-cubic',
      });
    },

    zoomToEdges(ids) {
      if (!this.cy) return;
      let eles = this.cy.collection();
      ids.forEach((id) => {
        const e = this.cy.getElementById(id);
        if (!e.empty()) eles = eles.union(e).union(e.connectedNodes());
      });
      if (eles.empty()) return;
      this.highlightEdges(ids);
      this.cy.animate({
        fit: { eles, padding: 80 },
        duration: 400,
        easing: 'ease-in-out-cubic',
      });
    },

    exportImage() {
      if (!this.cy) return;
      const fmt = (this.exportFormat || 'png').toLowerCase();
      const filename = `dependency-mesh.${fmt}`;
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--cy-bg').trim() || '#111827';

      if (fmt === 'svg') {
        if (typeof this.cy.svg !== 'function') {
          alert('SVG export plugin not loaded.');
          return;
        }
        const svgStr = this.cy.svg({ full: true, bg, scale: 1 });
        const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }

      // png / jpg
      const dataUrl = (fmt === 'jpg' || fmt === 'jpeg')
        ? this.cy.jpg({ full: true, bg, quality: 0.95 })
        : this.cy.png({ full: true, bg });
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = filename;
      link.click();
    },

    async copyShareLink() {
      const url = new URL(window.location);
      // Remove params the user chose to exclude.
      if (!this.shareIncludeConfig) url.searchParams.delete('config');
      if (!this.shareIncludeEdgeColors) url.searchParams.delete('rules');
      if (!this.shareIncludeEdgeStyles) url.searchParams.delete('styleRules');
      if (!this.shareIncludeTheme) {
        url.searchParams.delete('main');
        url.searchParams.delete('accent');
        url.searchParams.delete('edge');
        url.searchParams.delete('mainText');
        url.searchParams.delete('accentText');
      }
      if (!this.shareIncludeBasicConfig) {
        url.searchParams.delete('nodeSize');
        url.searchParams.delete('shape');
        url.searchParams.delete('curve');
        url.searchParams.delete('hub');
        url.searchParams.delete('labels');
        url.searchParams.delete('font');
        url.searchParams.delete('fontSize');
      }
      await navigator.clipboard.writeText(url.toString());
      this.shareCopied = true;
      setTimeout(() => { this.shareCopied = false; }, 2000);
    },
  };
}

// Expose to Alpine (used via x-data="depManager()")
window.depManager = depManager;
