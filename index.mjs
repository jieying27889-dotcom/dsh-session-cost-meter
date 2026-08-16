/**
 * dsh-session-cost-meter — Host half.
 *
 * 常驻 cordis 插件：注册 `sessionCost` 会话投影（按每条消息的发送时间 ×
 * 官方价格表折叠成本），并提供三条 HTTP 路由给浏览器端：
 *   GET  /plugins/session-cost-meter/pricing   读取当前计费配置
 *   POST /plugins/session-cost-meter/pricing   保存计费配置（写入配置文件并重折投影）
 *   GET  /plugins/session-cost-meter/balance   查询 DeepSeek 账户余额（带缓存）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'session-cost-meter'
export const inject = ['sessionProjections', 'webServer']

const DEFAULT_CURRENCY = 'CNY'
const DEFAULT_PEAK_FROM = '2026-08-17T00:00:00+08:00'
const DEFAULT_PEAK_HOURS = { utcOffsetMinutes: 480, ranges: [[9, 12], [14, 18]] }
const DEFAULT_MODELS = {
  'deepseek-v4-flash': { input: 1.0, cacheHit: 0.02, output: 2.0, offPeak: { input: 1.5, cacheHit: 0.05, output: 4.5 }, peak: { input: 3.0, cacheHit: 0.1, output: 9.0 } },
  'deepseek-v4-pro': { input: 3.0, cacheHit: 0.025, output: 6.0, offPeak: { input: 4.5, cacheHit: 0.15, output: 13.5 }, peak: { input: 9.0, cacheHit: 0.3, output: 27.0 } },
  '*': { input: 1.0, cacheHit: 0.02, output: 2.0, offPeak: { input: 1.5, cacheHit: 0.05, output: 4.5 }, peak: { input: 3.0, cacheHit: 0.1, output: 9.0 } },
}
const PRICING_NOTE = '会话费用统计的价格表（单位：currency 币种 / 每 100 万 token）。input=输入(缓存未命中), cacheHit=输入(缓存命中), output=输出(reasoning 已含在内)。peakFrom 之前按当前价；之后按官方峰谷价（高峰=北京时间 9:00-12:00、14:00-18:00，闲时=高峰一半），自动按每条消息时间套用。数据来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 。由「设置 → 会话费用计费」页面保存。'

/**
 * 视图 schema：会话投影管线只调用 schema.parse(value) 校验 view() 输出。
 * 这里提供零依赖的等价校验器（不引入 zod，规避链接包依赖解析问题）。
 */
const viewSchema = {
  parse(value) {
    const fail = (why) => { throw new Error('sessionCost view 校验失败: ' + why) }
    if (typeof value !== 'object' || value === null) fail('不是对象')
    if (typeof value.totalCost !== 'number' || !Number.isFinite(value.totalCost)) fail('totalCost')
    if (typeof value.lastTurnCost !== 'number' || !Number.isFinite(value.lastTurnCost)) fail('lastTurnCost')
    if (typeof value.currentTurnCost !== 'number' || !Number.isFinite(value.currentTurnCost)) fail('currentTurnCost')
    const t = value.tokens
    if (!t || typeof t !== 'object') fail('tokens')
    if (typeof t.input !== 'number' || typeof t.output !== 'number' || typeof t.cacheRead !== 'number' || typeof t.cacheWrite !== 'number') fail('tokens 字段')
    if (typeof value.currency !== 'string') fail('currency')
    if (typeof value.unknownPricing !== 'boolean') fail('unknownPricing')
    return value
  },
}

function fin(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
}

function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return null
}

function normPrices(v) {
  if (!v || typeof v !== 'object') return null
  const base = { input: fin(v.input), cacheHit: fin(v.cacheHit), output: fin(v.output) }
  if (base.input <= 0 && base.cacheHit <= 0 && base.output <= 0) return null
  let offPeak = null
  if (v.offPeak && typeof v.offPeak === 'object') {
    const o = { input: fin(v.offPeak.input), cacheHit: fin(v.offPeak.cacheHit), output: fin(v.offPeak.output) }
    if (o.input > 0 || o.cacheHit > 0 || o.output > 0) offPeak = o
  }
  let peak = null
  if (v.peak && typeof v.peak === 'object') {
    const p = { input: fin(v.peak.input), cacheHit: fin(v.peak.cacheHit), output: fin(v.peak.output) }
    if (p.input > 0 || p.cacheHit > 0 || p.output > 0) peak = p
  }
  return { base, offPeak, peak }
}

/** 模块级计价状态；投影折叠与 HTTP 路由都读它。 */
const pricing = {
  currency: DEFAULT_CURRENCY,
  models: DEFAULT_MODELS,
  warning: null,
  peakFrom: DEFAULT_PEAK_FROM,
  peakFromMs: Date.parse(DEFAULT_PEAK_FROM),
  peakHours: DEFAULT_PEAK_HOURS,
  path: null,
  version: 1,
}

function defaultPricing(version) {
  return { ...pricing, currency: DEFAULT_CURRENCY, models: DEFAULT_MODELS, warning: null, peakFrom: DEFAULT_PEAK_FROM, peakFromMs: Date.parse(DEFAULT_PEAK_FROM), peakHours: DEFAULT_PEAK_HOURS, path: null, version }
}

function primaryPath() {
  const home = process.env.DSH_HOME || (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : null)
  return home ? join(home, '.dsh-cost.json') : join(process.cwd(), '.dsh-cost.json')
}

function sessionCwdPaths(ctx) {
  const paths = []
  const svc = ctx.get('sessions')
  if (svc && typeof svc.list === 'function') {
    try {
      for (const session of svc.list()) {
        const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : null
        if (cwd) {
          const p = join(cwd.replace(/[\\/]+$/, ''), '.dsh-cost.json')
          if (!paths.includes(p)) paths.push(p)
        }
      }
    } catch { /* 读不到就跳过 */ }
  }
  return paths
}

function parsePricing(text, path) {
  const cfg = JSON.parse(text)
  if (!cfg || typeof cfg !== 'object') throw new Error('内容不是对象')
  const models = {}
  const raw = cfg.models
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      const entry = normPrices(raw[key])
      if (entry) models[key] = entry
    }
  }
  if (Object.keys(models).length === 0) throw new Error('没有可用模型条目')
  const currency = typeof cfg.currency === 'string' && cfg.currency ? cfg.currency : DEFAULT_CURRENCY
  let peakFromText = null
  let peakFromMs = null
  if (typeof cfg.peakFrom === 'string' && cfg.peakFrom.trim()) {
    const ms = Date.parse(cfg.peakFrom.trim())
    if (Number.isFinite(ms)) { peakFromText = cfg.peakFrom.trim(); peakFromMs = ms }
  } else if (cfg.peakPricing === true) {
    peakFromText = null
    peakFromMs = 0
  }
  let peakHours = DEFAULT_PEAK_HOURS
  if (cfg.peakHours && typeof cfg.peakHours === 'object') {
    peakHours = {
      utcOffsetMinutes: typeof cfg.peakHours.utcOffsetMinutes === 'number' ? cfg.peakHours.utcOffsetMinutes : DEFAULT_PEAK_HOURS.utcOffsetMinutes,
      ranges: Array.isArray(cfg.peakHours.ranges) ? cfg.peakHours.ranges : DEFAULT_PEAK_HOURS.ranges,
    }
  }
  const version = Number.isSafeInteger(cfg.version) && cfg.version >= 1 ? cfg.version : 1
  return { currency, models, warning: null, peakFrom: peakFromText, peakFromMs, peakHours, path, version }
}

function loadPricingFrom(ctx) {
  const candidates = [primaryPath(), ...sessionCwdPaths(ctx)]
  let lastError = '没有候选路径'
  for (const path of candidates) {
    try {
      if (!existsSync(path)) { lastError = path + ': 文件不存在'; continue }
      const next = parsePricing(readFileSync(path, 'utf8'), path)
      Object.assign(pricing, next)
      return
    } catch (error) {
      lastError = path + ': ' + String((error && error.message) || error)
    }
  }
  Object.assign(pricing, defaultPricing(pricing.version), { warning: String(lastError).slice(0, 160) })
}

function entryFor(model) {
  const table = pricing.models || {}
  const hit = normPrices(table[model])
  if (hit) return { entry: hit, exact: true }
  const star = normPrices(table['*'])
  if (star) return { entry: star, exact: false }
  const builtin = normPrices(DEFAULT_MODELS[model] || DEFAULT_MODELS['*'])
  return { entry: builtin, exact: false }
}

function inPeakRange(timeMs) {
  const ph = pricing.peakHours || DEFAULT_PEAK_HOURS
  const offsetSec = (typeof ph.utcOffsetMinutes === 'number' ? ph.utcOffsetMinutes : 480) * 60
  const ranges = Array.isArray(ph.ranges) ? ph.ranges : DEFAULT_PEAK_HOURS.ranges
  const daySec = 86400
  const secs = Math.floor((typeof timeMs === 'number' && timeMs > 0 ? timeMs : Date.now()) / 1000) + offsetSec
  const local = ((secs % daySec) + daySec) % daySec
  const minutes = local / 60
  for (const r of ranges) {
    if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number') {
      if (minutes >= r[0] * 60 && minutes < r[1] * 60) return true
    }
  }
  return false
}

function pickEntry(entry, timeMs) {
  const pf = pricing.peakFromMs
  const t = typeof timeMs === 'number' && timeMs > 0 ? timeMs : 0
  if (pf === null || !Number.isFinite(pf) || t < pf) return entry.base
  const off = entry.offPeak || entry.base
  if (inPeakRange(t)) {
    if (entry.peak) return entry.peak
    return { input: off.input * 2, cacheHit: off.cacheHit * 2, output: off.output * 2 }
  }
  return off
}

function initState() {
  return {
    total: 0, current: 0, last: 0,
    openTurn: null, seen: false, unknownPricing: false,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

function fold(state, event) {
  const type = event && event.type
  if (type === 'assistant/message') {
    const data = event.data
    if (!data || typeof data !== 'object') return state
    const usage = data.usage
    if (!usage || typeof usage !== 'object') return state
    const msg = data.message
    const source = msg && typeof msg === 'object' ? msg.source : null
    const model = source && typeof source === 'object' && typeof source.model === 'string' ? source.model : '*'
    const priced = entryFor(model)
    const time = typeof event.time === 'number' ? event.time : 0
    const rate = pickEntry(priced.entry, time)
    const input = fin(usage.inputTokens)
    const output = fin(usage.outputTokens)
    const cacheRead = fin(usage.cacheReadTokens)
    const cacheWrite = fin(usage.cacheWriteTokens)
    const cost = ((input + cacheWrite) * rate.input + cacheRead * rate.cacheHit + output * rate.output) / 1e6
    const next = {
      ...state,
      seen: true,
      total: state.total + cost,
      tokens: {
        input: state.tokens.input + input,
        output: state.tokens.output + output,
        cacheRead: state.tokens.cacheRead + cacheRead,
        cacheWrite: state.tokens.cacheWrite + cacheWrite,
      },
      unknownPricing: state.unknownPricing || !priced.exact,
    }
    const turn = typeof data.turn === 'number' ? data.turn : null
    if (turn === null) return { ...next, current: next.current + cost }
    if (state.openTurn === null) return { ...next, openTurn: turn, current: next.current + cost }
    if (turn === state.openTurn) return { ...next, current: next.current + cost }
    if (turn > state.openTurn) return { ...next, last: state.current, current: cost, openTurn: turn }
    return next
  }
  if (type === 'turn/start') {
    const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : null
    if (turn === null) return state
    return { ...state, current: 0, openTurn: turn }
  }
  if (type === 'turn/end') {
    return { ...state, last: state.current, current: 0, openTurn: null }
  }
  return state
}

function makeDefinition(version) {
  return {
    key: 'sessionCost',
    schema: viewSchema,
    stateVersion: version,
    init: initState,
    apply: fold,
    view: (state) => ({
      totalCost: state.total,
      lastTurnCost: state.last,
      currentTurnCost: state.current,
      tokens: state.tokens,
      currency: pricing.currency,
      unknownPricing: state.unknownPricing,
    }),
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 65536) { reject(new Error('请求体过大')); req.destroy(); return }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  const text = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function pricingModelsOut() {
  const out = {}
  for (const key of Object.keys(pricing.models)) {
    const entry = pricing.models[key]
    out[key] = { ...entry.base, ...(entry.offPeak ? { offPeak: entry.offPeak } : {}), ...(entry.peak ? { peak: entry.peak } : {}) }
  }
  return out
}

function validateAndNormalize(body) {
  const currency = body && typeof body.currency === 'string' ? body.currency.trim() : ''
  if (!currency || currency.length > 12) throw new Error('币种无效（1-12 个字符）')
  const peakFromText = body && typeof body.peakFrom === 'string' ? body.peakFrom.trim() : ''
  let peakFromMs = null
  if (peakFromText) {
    peakFromMs = Date.parse(peakFromText)
    if (!Number.isFinite(peakFromMs)) throw new Error('峰谷价生效时间格式无效（留空=不启用）')
  }
  const rawModels = body && body.models && typeof body.models === 'object' ? body.models : null
  if (!rawModels) throw new Error('缺少模型价格')
  const models = {}
  for (const key of Object.keys(rawModels)) {
    if (typeof key !== 'string' || !key.trim() || key.trim().length > 80) throw new Error('存在无效的模型名')
    const v = rawModels[key]
    const base = { input: numOrNull(v && v.input), cacheHit: numOrNull(v && v.cacheHit), output: numOrNull(v && v.output) }
    if (base.input === null || base.cacheHit === null || base.output === null) throw new Error('模型 ' + key + ' 的当前价格必须是 ≥0 的数字')
    const out = { ...base }
    if (v && v.offPeak && typeof v.offPeak === 'object') {
      const offPeak = { input: numOrNull(v.offPeak.input), cacheHit: numOrNull(v.offPeak.cacheHit), output: numOrNull(v.offPeak.output) }
      if (offPeak.input === null || offPeak.cacheHit === null || offPeak.output === null) throw new Error('模型 ' + key + ' 的闲时价格必须是 ≥0 的数字')
      out.offPeak = offPeak
    }
    if (v && v.peak && typeof v.peak === 'object') {
      const peak = { input: numOrNull(v.peak.input), cacheHit: numOrNull(v.peak.cacheHit), output: numOrNull(v.peak.output) }
      if (peak.input === null || peak.cacheHit === null || peak.output === null) throw new Error('模型 ' + key + ' 的高峰价格必须是 ≥0 的数字')
      out.peak = peak
    }
    models[key.trim()] = out
  }
  if (Object.keys(models).length === 0) throw new Error('至少需要一个模型条目')
  return { currency, peakFromText, peakFromMs, models }
}

export function apply(ctx) {
  loadPricingFrom(ctx)
  let registration = null
  let currentVersion = pricing.version

  function reregister() {
    if (registration) {
      try { registration() } catch { /* 已释放则忽略 */ }
    }
    registration = ctx.sessionProjections.register(makeDefinition(currentVersion))
  }
  reregister()

  const webServer = ctx.webServer
  const balanceCache = { at: 0, value: null, lastGood: null, lastGoodAt: 0 }
  const projectCache = { key: null, at: 0, value: null }
  const projectInFlight = new Map()

  // 任何会话的投影发生变化（新消息落地/价格重算）都作废项目缓存，下次请求即得最新合计。
  // 计算本身是零 IO 的投影缓存求和，且请求侧有 30s 缓存 + single-flight，不会放大负载。
  if (typeof ctx.sessionProjections.onChanged === 'function') {
    ctx.effect(() => ctx.sessionProjections.onChanged(() => { projectCache.at = 0 }))
  }

  function normCwd(p) {
    return String(p || '').replace(/[\\/]+$/, '').toLowerCase()
  }

  async function computeProject(cwd) {
    const target = normCwd(cwd)
    const seen = new Set()
    const liveById = new Map()
    const svc = ctx.get('sessions')
    if (svc && typeof svc.list === 'function') {
      try {
        for (const session of svc.list()) {
          if (session && normCwd(session.header && session.header.cwd) === target) {
            const id = String(session.id)
            seen.add(id)
            liveById.set(id, session)
          }
        }
      } catch { /* 读不到活动会话则跳过 */ }
    }
    let total = 0
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

    function addCost(cost) {
      if (!cost || typeof cost.totalCost !== 'number' || !Number.isFinite(cost.totalCost)) return
      total += cost.totalCost
      const t = cost.tokens
      if (t && typeof t === 'object') {
        tokens.input += fin(t.input)
        tokens.output += fin(t.output)
        tokens.cacheRead += fin(t.cacheRead)
        tokens.cacheWrite += fin(t.cacheWrite)
      }
    }

    // 活动会话：直接读实时投影快照（eager-drive 已维护，O(1)，不重放日志）
    const projections = ctx.sessionProjections
    if (projections && typeof projections.snapshot === 'function') {
      for (const session of liveById.values()) {
        try {
          const snap = projections.snapshot(session)
          if (snap && snap.values) addCost(snap.values.sessionCost)
        } catch { /* 单个会话读取失败不影响整体 */ }
      }
    }

    // 持久化会话：用零 IO 投影缓存读取，绝不 readSession 全量回放日志
    const persistence = ctx.get('sessionPersistence')
    let cache = null
    try { cache = ctx.get('sessionProjectionCache') } catch { /* 未挂载则跳过持久化会话 */ }
    if (persistence && typeof persistence.list === 'function' && cache && typeof cache.cachedSnapshot === 'function') {
      try {
        const headers = await persistence.list()
        for (const header of headers) {
          if (!header || normCwd(header.cwd) !== target) continue
          const id = String(header.id)
          seen.add(id)
          if (liveById.has(id)) continue // 活动会话已计入
          try {
            const cut = cache.cachedSnapshot(header)
            if (cut && cut.values) addCost(cut.values.sessionCost)
          } catch { /* 单会话缓存缺失/损坏则跳过 */ }
        }
      } catch { /* 持久化列表失败则只统计活动会话 */ }
    }

    return { cwd, sessionCount: seen.size, projectCost: total, tokens }
  }

  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/session-cost-meter/project-total',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://x')
          const sid = url.searchParams.get('sessionId') || ''
          let cwd = null
          const svc = ctx.get('sessions')
          if (svc && typeof svc.list === 'function') {
            try {
              for (const session of svc.list()) {
                if (String(session.id) === sid && session.header && typeof session.header.cwd === 'string') {
                  cwd = session.header.cwd
                  break
                }
              }
            } catch { /* 继续 */ }
          }
          if (cwd === null) {
            const persistence = ctx.get('sessionPersistence')
            if (persistence && typeof persistence.list === 'function') {
              try {
                const headers = await persistence.list()
                for (const header of headers) {
                  if (header && String(header.id) === sid && typeof header.cwd === 'string') { cwd = header.cwd; break }
                }
              } catch { /* 继续 */ }
            }
          }
          if (cwd === null) return sendJson(res, 200, { ok: false, error: '无法确定会话所属项目目录' })
          const key = normCwd(cwd)
          const now = Date.now()
          if (projectCache.key === key && projectCache.value && now - projectCache.at < 30000) {
            return sendJson(res, 200, projectCache.value)
          }
          // 单飞：同一项目目录并发请求复用同一个在途计算，避免缓存击穿
          let inflight = projectInFlight.get(key)
          if (!inflight) {
            inflight = (async () => {
              try {
                const value = await computeProject(cwd)
                const cached = { ok: true, ...value }
                projectCache.key = key
                projectCache.at = Date.now()
                projectCache.value = cached
                return cached
              } finally {
                projectInFlight.delete(key)
              }
            })()
            projectInFlight.set(key, inflight)
          }
          const value = await inflight
          return sendJson(res, 200, value)
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String((error && error.message) || error).slice(0, 160) })
        }
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/session-cost-meter/pricing',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const body = await readBody(req)
            let parsed
            try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
            try {
              const normalized = validateAndNormalize(parsed)
              const path = primaryPath()
              mkdirSync(dirname(path), { recursive: true })
              currentVersion = pricing.version + 1
              const contentObj = { _note: PRICING_NOTE, currency: normalized.currency, models: normalized.models, version: currentVersion }
              if (normalized.peakFromText) contentObj.peakFrom = normalized.peakFromText
              writeFileSync(path, JSON.stringify(contentObj, null, 2), 'utf8')
              Object.assign(pricing, {
                currency: normalized.currency,
                models: normalized.models,
                warning: null,
                peakFrom: normalized.peakFromText || null,
                peakFromMs: normalized.peakFromMs,
                peakHours: DEFAULT_PEAK_HOURS,
                path,
                version: currentVersion,
              })
              reregister()
              return sendJson(res, 200, { ok: true, path })
            } catch (error) {
              return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
            }
          }
          loadPricingFrom(ctx)
          return sendJson(res, 200, {
            ok: true,
            path: pricing.path || primaryPath(),
            fileExists: pricing.path !== null,
            currency: pricing.currency,
            peakFrom: pricing.peakFrom || '',
            peakHours: pricing.peakHours,
            models: pricingModelsOut(),
            warning: pricing.warning || null,
            defaults: { currency: DEFAULT_CURRENCY, peakFrom: DEFAULT_PEAK_FROM, models: DEFAULT_MODELS },
          })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/session-cost-meter/balance',
      handler: async (req, res) => {
        const now = Date.now()
        if (balanceCache.value && now - balanceCache.at < 30000) return sendJson(res, 200, balanceCache.value)
        let result
        try {
          let apiKeyEnv = 'DEEPSEEK_API_KEY'
          let baseURL = 'https://api.deepseek.com'
          const settings = ctx.get('settings')
          if (settings && typeof settings.get === 'function') {
            try {
              const section = settings.get('llm-deepseek')
              if (section && typeof section === 'object') {
                if (typeof section.apiKeyEnv === 'string' && section.apiKeyEnv) apiKeyEnv = section.apiKeyEnv
                if (typeof section.baseURL === 'string' && section.baseURL) baseURL = section.baseURL
              }
            } catch { /* 保持默认 */ }
          }
          const credentials = ctx.get('credentials')
          let key = null
          if (credentials && typeof credentials.resolve === 'function') {
            try {
              const hit = await credentials.resolve(apiKeyEnv)
              if (hit && typeof hit.value === 'string' && hit.value) key = hit.value
            } catch { /* 走未找到分支 */ }
          }
          if (!key) {
            result = { ok: false, error: '未找到 API Key（' + apiKeyEnv + '）' }
          } else {
            const url = baseURL.replace(/\/+$/, '') + '/user/balance'
            const r = await fetch(url, { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) })
            const text = await r.text()
            const trimmed = text.trim()
            try {
              const body = JSON.parse(trimmed)
              if (body && Array.isArray(body.balance_infos) && body.balance_infos.length > 0) {
                const info = body.balance_infos[0] || {}
                result = {
                  ok: true,
                  available: body.is_available !== false,
                  currency: typeof info.currency === 'string' ? info.currency : '',
                  totalBalance: info.total_balance != null ? String(info.total_balance) : null,
                  grantedBalance: info.granted_balance != null ? String(info.granted_balance) : null,
                  toppedUpBalance: info.topped_up_balance != null ? String(info.topped_up_balance) : null,
                  asOf: Date.now(),
                }
              } else {
                const msg = body && body.error && typeof body.error.message === 'string' ? body.error.message : ''
                result = { ok: false, error: msg ? ('HTTP ' + r.status + ': ' + msg) : ('HTTP ' + r.status + ': 余额接口返回无法识别') }
              }
            } catch {
              result = { ok: false, error: 'HTTP ' + r.status + ': 响应解析失败 (' + trimmed.slice(0, 100) + ')' }
            }
          }
        } catch (error) {
          result = { ok: false, error: '余额请求失败: ' + String((error && error.message) || error).slice(0, 160) }
        }
        balanceCache.at = now
        if (result.ok) {
          balanceCache.value = result
          balanceCache.lastGood = result
          balanceCache.lastGoodAt = now
          return sendJson(res, 200, result)
        }
        if (balanceCache.lastGood && now - balanceCache.lastGoodAt < 300000) {
          return sendJson(res, 200, { ...balanceCache.lastGood, stale: true, error: result.error })
        }
        return sendJson(res, 200, result)
      },
    }))
  }
}
