/**
 * Host-load test: evaluates `lib/index.js` the way the DSH loader would, with a
 * fake Cordis context, and asserts the plugin actually registers what it claims.
 *
 * Why this exists: the plugin's whole host surface is three `ctx.get()` calls and
 * one `ctx.inject()`. Those cannot be exercised by the CLI (separate process) and
 * cannot be exercised without restarting DSH (the profile tree is composed at
 * boot). This harness closes that gap — in particular it runs the **real**
 * `defineTool()` from `@deepseek-ai/dsh-tools`, which is where the "`required` is
 * not supported by the value schema DSL" class of failure shows up at definition
 * time.
 *
 * Run: node scripts/host-load-test.mjs
 */

const REQUIRED_TOOLS = ['aivideo_probe', 'aivideo_detect_shots', 'aivideo_analyze', 'aivideo_split'];

const registered = { tools: [], skills: [], routes: [], logs: [] };
let disposersCalled = 0;

function makeWebServer() {
  return {
    register(route) {
      registered.routes.push(route);
      return () => { disposersCalled += 1; };
    },
  };
}

function makeCtx() {
  const services = {
    tools: {
      register(def) {
        registered.tools.push(def);
        return () => { disposersCalled += 1; };
      },
    },
    skills: {
      register(skill) {
        registered.skills.push(skill);
        return () => { disposersCalled += 1; };
      },
    },
    webServer: makeWebServer(),
  };

  const ctx = {
    get(name) {
      return services[name];
    },
    // cordis: ctx.inject(['webServer'], cb) hands `cb` a context where the
    // dependency is available. Our fake has it immediately, like desktop does.
    inject(deps, cb) {
      const missing = deps.filter((d) => !services[d]);
      if (missing.length) return ctx;
      cb(ctx);
      return ctx;
    },
    logger: {
      info: (m) => registered.logs.push(['info', m]),
      warn: (m) => registered.logs.push(['warn', m]),
      error: (m) => registered.logs.push(['error', m]),
    },
    effect(fn) {
      const dispose = fn();
      ctx.__dispose = dispose;
      return dispose;
    },
  };
  return ctx;
}

const failures = [];
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const t0 = Date.now();
const mod = await import('../lib/index.js');

console.log('# 插件入口契约');
check('导出 name', typeof mod.name === 'string' && mod.name.length > 0, `name=${mod.name}`);
check('导出 inject 数组', Array.isArray(mod.inject), `inject=${JSON.stringify(mod.inject)}`);
check('导出 apply 函数', typeof mod.apply === 'function');
check('导出 Config.~standard.validate', typeof mod.Config?.['~standard']?.validate === 'function');

console.log('\n# Config 校验');
const v = mod.Config['~standard'].validate;
check('空配置返回默认值', !!v(null).value && v(null).value.minShotSeconds === 1.5, JSON.stringify(v(null)));
check('合法配置通过', !v({ minShotSeconds: 2, ffmpegPath: 'x' }).issues);
check('未知键被拒', !!v({ nope: 1 }).issues, JSON.stringify(v({ nope: 1 })));
check('类型错误被拒', !!v({ minShotSeconds: '2' }).issues, JSON.stringify(v({ minShotSeconds: '2' })));
check('越界被拒', !!v({ minScore: 5 }).issues, JSON.stringify(v({ minScore: 5 })));

console.log('\n# apply()：工具 / 技能 / 路由注册');
const ctx = makeCtx();
mod.apply(ctx, {});
await new Promise((r) => setTimeout(r, 600)); // install() 是异步的

const toolNames = registered.tools.map((d) => d.name);
for (const want of REQUIRED_TOOLS) check(`注册工具 ${want}`, toolNames.includes(want), `实际=${toolNames.join(',')}`);

// `defineTool` normalises the host DSL (`{ type, required: true }` per property)
// into real JSON Schema: the property-level flag disappears and a top-level
// `required: [...]` array appears. Assert on the *normalised* shape, because that
// is what the model actually sees.
for (const def of registered.tools) {
  check(`  ${def.name}: 有 description`, typeof def.description === 'string' && def.description.length > 10);
  const params = def.parameters || {};
  check(`  ${def.name}: parameters 是 JSON Schema`, params.type === 'object' && !!params.properties, JSON.stringify(params).slice(0, 80));
  check(`  ${def.name}: 有 execute`, typeof def.execute === 'function');
  const required = Array.isArray(params.required) ? params.required : [];
  check(`  ${def.name}: video 是必填参数`, required.includes('video'), `required=${JSON.stringify(required)}`);
  const props = Object.keys(params.properties || {});
  check(`  ${def.name}: 参数非空`, props.length > 0, `props=${props.join(',')}`);
}

console.log('\n# 注册的技能');
check('注册了 1 个技能', registered.skills.length === 1, `count=${registered.skills.length}`);
const skill = registered.skills[0] || {};
check('技能名 aivideo-shotkit', skill.name === 'aivideo-shotkit');
check('技能有 content', typeof skill.content === 'string' && skill.content.length > 500, `len=${(skill.content || '').length}`);
check('技能有 resourceBase', skill.resourceBase?.kind === 'directory');

console.log('\n# 只读状态路由');
check('挂了 1 条路由', registered.routes.length === 1, `count=${registered.routes.length}`);
check('路由路径 /aivideo-shotkit/state', registered.routes[0]?.path === '/aivideo-shotkit/state', registered.routes[0]?.path);
check('路由是 exact', registered.routes[0]?.kind === 'exact');

console.log('\n# 路由真的能应答');
if (registered.routes[0]) {
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, val) { this.headers[k] = val; },
    end(body) { if (body) chunks.push(String(body)); },
  };
  registered.routes[0].handler({ method: 'GET', url: '/aivideo-shotkit/state' }, res);
  let payload = null;
  try { payload = JSON.parse(chunks.join('')); } catch { /* stays null */ }
  check('GET 返回 200', res.statusCode === 0 || res.statusCode === 200, `status=${res.statusCode}`);
  check('返回合法 JSON', !!payload, chunks.join('').slice(0, 120));
  check('payload.ok 为 true', payload?.ok === true);
  check('payload 带 state', !!payload?.state && typeof payload.state === 'object');

  const res2 = { statusCode: 0, setHeader() {}, end() {} };
  registered.routes[0].handler({ method: 'POST', url: '/aivideo-shotkit/state' }, res2);
  check('POST 被拒（405）', res2.statusCode === 405, `status=${res2.statusCode}`);
}

console.log('\n# 卸载');
check('effect 返回了 disposer', typeof ctx.__dispose === 'function');
if (typeof ctx.__dispose === 'function') {
  ctx.__dispose();
  check('disposer 执行了注册时拿到的 dispose', disposersCalled >= 1, `called=${disposersCalled}`);
}

console.log('\n# 日志');
for (const [level, m] of registered.logs) console.log(`  [${level}] ${m}`);
if (registered.logs.some(([l]) => l === 'error')) failures.push('有 error 级日志');

console.log(`\n用时 ${Date.now() - t0}ms`);
if (failures.length) {
  console.log(`\n❌ ${failures.length} 项失败：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\n✅ 宿主契约全部通过');
