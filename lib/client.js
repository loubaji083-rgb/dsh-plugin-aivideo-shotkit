/**
 * dsh-plugin-aivideo-shotkit — browser side (DSH Web / Desktop).
 *
 * Wrapped the way the DSH client module loader expects (same shape as the
 * wallpaper-engine plugin): a `__ModuleLoader__.load({ id, factory })` call
 * whose factory receives a `require` and returns the module exports. It is NOT
 * a plain ESM file — `lib/client.js` is fetched by the host loader, not by
 * `import` in the browser.
 *
 * Scope: this panel is a **status light**, not a控制台. It reads the read-only
 * route `/aivideo-shotkit/state` (mounted by `lib/index.js`) and renders the most
 * recent analysis/split. Long jobs stay in the chat tools, where they can stream
 * progress and be cancelled — a panel button that silently spawns ffmpeg for
 * minutes would be a worse experience, not a better one.
 *
 * The only slot used is `settings.section`, because that is the registration
 * pattern that could be read straight out of an installed plugin's bundle
 * (`dsh-plugin-wallpaper-engine`) and therefore verified, rather than guessed.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-aivideo-shotkit',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const STATE_URL = '/aivideo-shotkit/state';
    const POLL_MS = 3000;

    const C = {
      fg: 'var(--dsh-text-primary, #e8e8ea)',
      dim: 'var(--dsh-text-secondary, #9a9aa2)',
      faint: 'var(--dsh-text-tertiary, #6e6e78)',
      line: 'var(--dsh-border-subtle, rgba(128,128,140,0.25))',
      accent: 'var(--dsh-accent, #4c8dff)',
      ok: '#3fb950',
      warn: '#d29922',
      bad: '#f85149',
      bg: 'var(--dsh-surface-sunken, rgba(128,128,140,0.06))',
    };

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px', color: C.fg, lineHeight: 1.55 },
      card: { border: `1px solid ${C.line}`, borderRadius: '8px', padding: '10px 12px', background: C.bg },
      h: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' },
      row: { display: 'flex', gap: '8px', alignItems: 'baseline' },
      k: { color: C.dim, minWidth: '76px', flexShrink: 0 },
      v: { flex: 1, wordBreak: 'break-all' },
      mono: { fontFamily: 'var(--dsh-font-mono, ui-monospace, Consolas, monospace)', fontSize: '11px' },
      btn: {
        border: `1px solid ${C.line}`, borderRadius: '6px', padding: '4px 10px',
        background: 'transparent', color: C.fg, cursor: 'pointer', fontSize: '11px',
      },
      tag: {
        display: 'inline-block', border: `1px solid ${C.line}`, borderRadius: '999px',
        padding: '0 7px', marginRight: '5px', fontSize: '11px', color: C.dim,
      },
    };

    function fmtTime(sec) {
      const s = Math.max(0, Number(sec) || 0);
      const m = Math.floor(s / 60);
      const r = s - m * 60;
      return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
    }

    function fmtBytes(n) {
      const v = Number(n) || 0;
      if (v < 1024) return `${v} B`;
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
      if (v < 1024 * 1024 * 1024) return `${(v / 1048576).toFixed(1)} MB`;
      return `${(v / 1073741824).toFixed(2)} GB`;
    }

    function pct(v) {
      return `${Math.round((Number(v) || 0) * 100)}%`;
    }

    function verdictColor(replaceability) {
      const r = Number(replaceability) || 0;
      if (r >= 0.75) return C.ok;
      if (r >= 0.55) return C.accent;
      if (r >= 0.4) return C.warn;
      return C.bad;
    }

    function useShotkitState() {
      const [data, setData] = useState(null);
      const [err, setErr] = useState(null);
      const [live, setLive] = useState(true);

      const load = useCallback(async () => {
        try {
          const res = await fetch(STATE_URL, { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setData(await res.json());
          setErr(null);
          setLive(true);
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
          setLive(false);
        }
      }, []);

      useEffect(() => {
        let alive = true;
        const tick = () => { if (alive) load(); };
        tick();
        const id = setInterval(tick, POLL_MS);
        return () => { alive = false; clearInterval(id); };
      }, [load]);

      return { data, err, live, reload: load };
    }

    function StatusLine({ live, err }) {
      const color = live ? C.ok : C.bad;
      const text = live ? '宿主已连接（只读状态路由 /aivideo-shotkit/state）'
        : `读不到宿主状态：${err || '未知错误'}——插件可能未随 profile 启动`;
      return h('div', { style: S.row },
        h('span', { style: { color, fontSize: '14px', lineHeight: 1 } }, '\u25CF'),
        h('span', { style: { ...S.v, color: C.dim } }, text));
    }

    function KV({ k, v }) {
      return h('div', { style: S.row }, h('div', { style: S.k }, k), h('div', { style: S.v }, v));
    }

    function GroupTags({ groups }) {
      const keys = Object.keys(groups || {});
      if (!keys.length) return null;
      return h('div', { style: { marginTop: '4px' } },
        keys.map((k) => h('span', { key: k, style: S.tag }, `${k} × ${groups[k]}`)));
    }

    function ShotTable({ shots }) {
      if (!shots || !shots.length) return null;
      const th = { textAlign: 'left', color: C.faint, fontWeight: 500, padding: '3px 6px 3px 0' };
      const td = { padding: '3px 6px 3px 0', verticalAlign: 'top' };
      return h('table', { style: { width: '100%', borderCollapse: 'collapse', marginTop: '4px' } },
        h('thead', null, h('tr', null,
          h('th', { style: th }, '#'),
          h('th', { style: th }, '时间'),
          h('th', { style: th }, '分段'),
          h('th', { style: th }, '分布'),
          h('th', { style: th }, '判定'))),
        h('tbody', null, shots.map((s) => h('tr', { key: s.index },
          h('td', { style: { ...td, ...S.mono } }, s.index),
          h('td', { style: { ...td, ...S.mono, whiteSpace: 'nowrap' } }, `${fmtTime(s.start)}`),
          h('td', { style: { ...td, ...S.mono } }, s.segmentCount > 1 ? `${s.segmentCount}段` : '整段'),
          h('td', { style: { ...td, ...S.mono } }, pct(s.motionCoverage)),
          h('td', { style: { ...td, color: verdictColor(s.replaceability) } }, s.verdict || '—')))));
    }

    function EmptyState() {
      return h('div', { style: S.card },
        h('div', { style: S.h }, '还没有分析记录'),
        h('div', { style: { color: C.dim } },
          '在对话里对助手说：', h('br'),
          h('code', { style: S.mono }, '用 aivideo_run 处理 <视频路径>，切成可以直接做人物替换的片段'),
          h('br'), h('br'),
          '或先把镜头切出来看：', h('br'),
          h('code', { style: S.mono }, '用 aivideo_analyze 分析 <视频路径>，并生成 filmstrip')));
    }

    function ResultView({ state, reload }) {
      const a = state.analysis;
      const cut = state.cut;
      const ready = !a ? null : [
        a.input && h(KV, { key: '源文件', k: '源文件', v: h('span', { style: S.mono }, a.input) }),
        h(KV, {
          key: 'size', k: '画面', v: h('span', { style: S.mono },
            `${a.width || '?'}×${a.height || '?'}${a.crop ? `（已裁到可玩区）` : ''}`
            + (a.playerUi ? '　播放器 UI 覆盖层已自动裁掉' : '')),
        }),
        a.duration != null && h(KV, { key: 'dur', k: '时长', v: `${Number(a.duration).toFixed(2)}s` }),
        h(KV, {
          key: 'plan', k: '切割计划',
          v: `${a.shotCount} 个镜头 → `
            + h('strong', null, `${a.segmentCount} 个片段`)
            + `，其中 ${a.recommended} 个建议直接用于替换`
            + (a.segmentPresetLabel ? `　窗口 ${a.window}s（${a.segmentPresetLabel}），重叠 ${a.overlapSec}s` : ''),
        }),
        h(KV, { key: 'groups', k: '分组', v: h(GroupTags, { groups: a.groups }) }),
      ].filter(Boolean);

      return h(React.Fragment, null,
        ready && h('div', { style: S.card }, h('div', { style: S.h }, '最近一次分析'), ready),

        a && a.top && a.top.length
          ? h('div', { style: S.card },
            h('div', { style: S.h }, '优先处理的镜头（按可替换性排序）'),
            h(ShotTable, { shots: a.top }),
            h('div', { style: { color: C.faint, marginTop: '6px' } },
              '「分布」＝画面中有明显运动的区域占比：越小说明只有主体在动、背景干净，越好替换。'),
            h('div', { style: { color: C.faint } },
              '这不是人脸检测，也推不出镜头尺度——近景/全身请对照 filmstrip.jpg 目视确认。'))
          : null,

        cut
          ? h('div', { style: S.card },
            h('div', { style: S.h }, '最近一次切割'),
            h(KV, {
              key: 'c1', k: '模式',
              v: cut.mode === 'copy' ? '无损 -c copy（切点吸附关键帧，不帧精确）' : '帧精确重编码 libx264',
            }),
            h(KV, {
              key: 'c2', k: '产出',
              v: `${cut.total} 个文件，成功 ${cut.ok}${cut.failed ? `，失败 ${cut.failed}` : ''}　共 ${fmtBytes(cut.bytes)}`
                + (cut.segmented ? '　（已按模型窗口二次切分）' : ''),
            }),
            h(KV, {
              key: 'c3', k: '输出目录',
              v: h('span', { style: S.mono }, cut.outputDir || '—'),
            }))
          : null,

        h('div', { style: S.card },
          h('div', { style: S.h }, '下一步'),
          h('div', { style: { color: C.dim } },
            '输出目录里有 workflow.json（机器可读）、提示词 CSV、以及一份 README.md 说明每条片段该投给哪个工具。',
            h('br'),
            '回到对话里让助手继续即可——本面板只读，不触发任务。'),
          h('div', { style: { marginTop: '8px' } },
            h('button', { style: S.btn, onClick: reload }, '立即刷新'))));
    }

    function ShotkitSection() {
      const { data, err, live, reload } = useShotkitState();
      const state = data && data.state ? data.state : null;
      return h('div', { style: S.wrap },
        h(StatusLine, { live, err }),
        state && state.error
          ? h('div', { style: { ...S.card, borderColor: C.bad, color: C.bad } }, `上次运行出错：${state.error}`)
          : null,
        state && state.analysis ? h(ResultView, { state, reload }) : h(EmptyState, null));
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'aivideo-shotkit', order: 620, label: 'AI 视频切片' },
        () => h(ShotkitSection, null),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ShotkitSection = ShotkitSection;
    return module.exports;
  },
});
