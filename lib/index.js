/**
 * dsh-plugin-aivideo-shotkit — DSH host entry.
 *
 * Registers four native tools plus one skill. Everything heavy lives in
 * `lib/core/*` and is pure Node (spawn + typed arrays); `bin/shotkit.mjs` runs
 * the very same core from the command line, so the plugin can be exercised
 * without a running host.
 *
 * Host packages are imported *lazily* on purpose: if a profile lacks
 * `@deepseek-ai/dsh-tools`, the tools silently do not register but the skill
 * still loads and the CLI still works. A static import here would make the
 * whole entry fail to evaluate instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { snapshot } from './core/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..', 'skills', 'aivideo-shotkit');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');

export const name = 'dsh-plugin-aivideo-shotkit';

/** `skills` is a hard dependency: the skill is this plugin's main interface. */
export const inject = ['skills'];

export const DEFAULTS = {
  ffmpegPath: '',
  minShotSeconds: 1.5,
  minScore: 0.3,
  cropBottomPx: 0,
  sampleTargetFrames: 1800,
  autoSides: false,
  registerTools: true,
  registerSkill: true,
};

const NUMERIC = ['minShotSeconds', 'minScore', 'cropBottomPx', 'sampleTargetFrames'];
const BOOLEAN = ['autoSides', 'registerTools', 'registerSkill'];
const STRING = ['ffmpegPath'];

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'aivideo-shotkit',
    validate(input) {
      const issues = [];
      const value = { ...DEFAULTS };
      if (input == null) return { value };
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'config 必须是一个对象', path: [] }] };
      }
      for (const [key, v] of Object.entries(input)) {
        if (!(key in DEFAULTS)) {
          issues.push({ message: `未知配置项：${key}`, path: [key] });
          continue;
        }
        if (STRING.includes(key)) {
          if (typeof v !== 'string') issues.push({ message: `${key} 必须是字符串`, path: [key] });
          else value[key] = v;
        } else if (NUMERIC.includes(key)) {
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            issues.push({ message: `${key} 必须是有限数字`, path: [key] });
          } else value[key] = v;
        } else if (BOOLEAN.includes(key)) {
          if (typeof v !== 'boolean') issues.push({ message: `${key} 必须是布尔值`, path: [key] });
          else value[key] = v;
        }
      }
      if (value.minShotSeconds <= 0) issues.push({ message: 'minShotSeconds 必须大于 0', path: ['minShotSeconds'] });
      if (value.minScore < 0 || value.minScore > 1) issues.push({ message: 'minScore 必须在 0~1 之间', path: ['minScore'] });
      if (value.cropBottomPx < 0) issues.push({ message: 'cropBottomPx 不能为负数', path: ['cropBottomPx'] });
      if (issues.length) return { issues };
      return { value };
    },
  },
};

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config || {}) };

  ctx.effect(() => {
    let disposed = false;
    const disposers = [];
    const log = (level, message) => {
      const logger = ctx.logger;
      if (typeof logger?.[level] === 'function') logger[level](`[aivideo-shotkit] ${message}`);
      else if (level === 'warn') console.warn(`[aivideo-shotkit] ${message}`);
    };

    const install = async () => {
      // ---- 原生工具（可选能力）：宿主缺 `tools` 服务或缺 dsh-tools 包时静默跳过
      const tools = ctx.get('tools');
      if (settings.registerTools && tools?.register) {
        try {
          const { defineTool } = await import('@deepseek-ai/dsh-tools');
          if (typeof defineTool !== 'function') throw new Error('defineTool 不是函数');
          const { buildToolDefs } = await import('./tools.js');
          if (!disposed) {
            for (const def of buildToolDefs(defineTool)) {
              const dispose = tools.register(def);
              if (typeof dispose === 'function') disposers.push(dispose);
            }
            log('info', '已注册 4 个原生工具：aivideo_probe / aivideo_detect_shots / aivideo_analyze / aivideo_split');
          }
        } catch (err) {
          log('warn', `原生工具未启用（无法取得 defineTool：${String(err?.code || err?.message).slice(0, 120)}）——CLI（bin/shotkit.mjs）与技能不受影响`);
        }
      }

      // ---- 只读状态路由（可选能力）：给浏览器面板喂数据
      //
      // `webServer` 刻意不写进 `inject`：没有 HTTP 服务的 profile（headless）
      // 应该照常拿到工具和技能，而不是整行挂起等一个永远不会出现的服务。
      // 因此这里用 cordis 的动态注入，服务就绪后再挂路由。
      const mountRoutes = (host) => {
        const webServer = host?.webServer || host?.get?.('webServer');
        if (!webServer || typeof webServer.register !== 'function') {
          log('warn', '未找到 webServer 服务，浏览器面板将没有数据（工具与 CLI 不受影响）');
          return;
        }
        if (disposed) return;
        try {
          disposers.push(webServer.register({
            kind: 'exact',
            path: '/aivideo-shotkit/state',
            handler: (req, res) => {
              if ((req.method || 'GET').toUpperCase() !== 'GET') {
                res.statusCode = 405;
                res.end('method not allowed');
                return;
              }
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.setHeader('Cache-Control', 'no-store');
              res.end(JSON.stringify(snapshot()));
            },
          }));
          log('info', '已挂载只读状态路由 /aivideo-shotkit/state');
        } catch (err) {
          log('warn', `状态路由挂载失败：${err?.message || err}`);
        }
      };

      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['webServer'], mountRoutes);
        } catch {
          mountRoutes(ctx);
        }
      } else {
        mountRoutes(ctx);
      }

      // ---- 技能（硬依赖，失败要吵）
      const skills = ctx.get('skills');
      if (settings.registerSkill && skills?.register) {
        try {
          const content = fs.readFileSync(SKILL_FILE, 'utf8');
          const dispose = skills.register({
            name: 'aivideo-shotkit',
            source: 'runtime',
            description:
              'AI 生成视频的分镜切割与人物替换工作流：识别播放器 UI 覆盖层、按场景切分镜、逐镜头评估并导出可投喂换脸/动作迁移工具的片段与工作流包。',
            whenToUse:
              '当用户提供一段视频（尤其是 AI 生成或录屏素材），想把它切成多个镜头/片段、或想做人物替换（换脸、动作迁移、数字人）时使用。',
            content,
            resourceBase: { kind: 'directory', path: SKILL_DIR },
          });
          if (typeof dispose === 'function') disposers.push(dispose);
          log('info', '已注册技能 aivideo-shotkit');
        } catch (err) {
          log('warn', `技能注册失败：${err.message}`);
        }
      }
    };

    install().catch((err) => log('warn', `初始化失败：${err?.message || err}`));

    return () => {
      disposed = true;
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* 卸载期的二次失败不值得影响宿主 */
        }
      }
    };
  });
}
