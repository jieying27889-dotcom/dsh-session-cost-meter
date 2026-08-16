/**
 * dsh-session-cost-meter — Client half（预构建 CJS bundle，经 __ModuleLoader__ 注册）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cost-meter',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var SYMBOL = { USD: '$', CNY: '¥', EUR: '€', GBP: '£' }
    function symOf(currency) {
      return SYMBOL[currency] || (currency ? currency + ' ' : '')
    }
    function fmtCost(n, currency) {
      if (n === null || n === undefined || typeof n !== 'number' || !Number.isFinite(n)) return '—'
      var s = symOf(currency)
      if (n < 0.01) return s + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
      return s + n.toFixed(2)
    }
    function fmtTokens(n) {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—'
      if (n < 1000) return String(Math.round(n))
      if (n < 1e6) return (n / 1e3).toFixed(1) + 'K'
      return (n / 1e6).toFixed(2) + 'M'
    }
    function fmtBalanceText(v) {
      if (!v || v.ok !== true) return null
      var total = v.totalBalance
      if (total === null || total === undefined || total === '') return v.available === false ? '不可用' : null
      var num = Number(total)
      var s = symOf(v.currency)
      if (!Number.isFinite(num)) return s + String(total)
      return s + num.toFixed(2)
    }
    function numStr(n) {
      return typeof n === 'number' && Number.isFinite(n) ? String(n) : ''
    }

    var pillStyle = {
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      fontSize: '12px', lineHeight: '12px', whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums', opacity: 0.85, cursor: 'default',
    }
    var sepStyle = { opacity: 0.55 }

    function Meter(props) {
      var turnEndsSize = props.useSession(function (s) { return s && s.turnEnds ? s.turnEnds.size : 0 }) || 0
      var running = props.useSession(function (s) { return !!(s && s.running) }) || false
      var sessionId = props.sessionId
      var cost = props.useProjection('sessionCost')

      var balState = React.useState(null)
      var balance = balState[0]
      var setBalance = balState[1]
      var errState = React.useState(null)
      var balanceError = errState[0]
      var setBalanceError = errState[1]
      var projectState = React.useState(null)
      var project = projectState[0]
      var setProject = projectState[1]

      React.useEffect(function () {
        if (!sessionId) return
        var alive = true
        fetch('/plugins/session-cost-meter/balance')
          .then(function (r) { return r.json() })
          .then(function (v) {
            if (!alive) return
            if (v && v.ok === true) { setBalance(v); setBalanceError(null) }
            else setBalanceError(v && v.error ? v.error : 'unknown')
          })
          .catch(function (e) { if (alive) setBalanceError(String((e && e.message) || e)) })
        return function () { alive = false }
      }, [sessionId, turnEndsSize])

      React.useEffect(function () {
        if (!sessionId) return
        var alive = true
        fetch('/plugins/session-cost-meter/project-total?sessionId=' + encodeURIComponent(String(sessionId)))
          .then(function (r) { return r.json() })
          .then(function (v) {
            if (alive && v && v.ok === true) setProject(v)
          })
          .catch(function () { if (alive) setProject(null) })
        return function () { alive = false }
      }, [sessionId, turnEndsSize])

      if (!sessionId) return null
      var currency = (cost && cost.currency) || 'CNY'
      var tracked = !!cost
      var turnCost = tracked ? (running ? cost.currentTurnCost : cost.lastTurnCost) : null
      var totalCost = tracked ? cost.totalCost : null
      var projectCost = project && typeof project.projectCost === 'number' ? project.projectCost : null
      var balText = fmtBalanceText(balance)
      var errShort = balanceError ? String(balanceError).slice(0, 24) + (String(balanceError).length > 24 ? '…' : '') : null
      var balShown = balText !== null ? balText : (balanceError ? '不可用（' + errShort + '）' : '…')
      var detail = '会话费用统计（金额为估算，以账单为准）'
      if (tracked && cost.unknownPricing) detail += '；部分消息的模型没有对应价格'
      if (tracked && cost.tokens) detail += '；token 输入 ' + fmtTokens(cost.tokens.input) + ' / 输出 ' + fmtTokens(cost.tokens.output) + ' / 缓存读 ' + fmtTokens(cost.tokens.cacheRead)
      if (project && typeof project.sessionCount === 'number') detail += '；项目含 ' + project.sessionCount + ' 个会话'
      if (balanceError) detail += '；余额错误：' + balanceError
      if (balance && balance.ok && balance.stale) detail += '；余额为上次成功值（刷新失败）'

      return React.createElement('span', { style: pillStyle, title: detail },
        React.createElement('span', null, '本轮 ', fmtCost(turnCost, currency)),
        React.createElement('span', { style: sepStyle }, '·'),
        React.createElement('span', null, '总计 ', fmtCost(totalCost, currency)),
        React.createElement('span', { style: sepStyle }, '·'),
        React.createElement('span', null, '项目 ', fmtCost(projectCost, currency)),
        React.createElement('span', { style: sepStyle }, '·'),
        React.createElement('span', null, '余额 ', balShown)
      )
    }

    var SETTINGS_CSS = [
      '.cm-settings{display:flex;flex-direction:column;gap:10px;font-size:13px;max-width:720px;padding:8px 0}',
      '.cm-settings h3{margin:0 0 2px}',
      '.cm-settings .cm-hint{opacity:.72;font-size:12px;margin:0}',
      '.cm-settings .cm-row{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;min-width:0}',
      '.cm-settings .cm-cell{flex:1;min-width:0}',
      '.cm-settings .cm-cell.cm-model{flex:1.4}',
      '.cm-settings .cm-cell.cm-del,.cm-settings .cm-del{flex:0 0 28px}',
      '.cm-settings .cm-model-block{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid rgba(127,127,127,.25);border-radius:8px}',
      '.cm-settings .cm-line-label{opacity:.7;font-size:12px}',
      '.cm-settings input,.cm-settings textarea{box-sizing:border-box;width:100%;min-width:0;font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.35);border-radius:6px;padding:4px 8px}',
      '.cm-settings input:focus,.cm-settings textarea:focus{outline:none;border-color:rgba(127,127,127,.7)}',
      '.cm-settings button{font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.4);border-radius:6px;padding:4px 10px;cursor:pointer}',
      '.cm-settings button:hover{border-color:rgba(127,127,127,.75)}',
      '.cm-settings button:disabled{opacity:.5;cursor:default}',
      '.cm-settings .cm-head{font-size:12px;opacity:.65}',
      '.cm-settings .cm-msg{font-size:12px;margin:0}',
      '.cm-settings .cm-ok{color:#2f9e44}',
      '.cm-settings .cm-err{color:#e03131}',
      '.cm-settings .cm-info{opacity:.75}',
      '.cm-settings .cm-json{width:100%;height:130px;font-family:ui-monospace,monospace;font-size:12px;white-space:pre}',
    ].join('')

    function PricingSettings() {
      var curState = React.useState('CNY')
      var currency = curState[0]
      var setCurrency = curState[1]
      var pfState = React.useState('2026-08-17T00:00:00+08:00')
      var peakFrom = pfState[0]
      var setPeakFrom = pfState[1]
      var rowsState = React.useState([])
      var rows = rowsState[0]
      var setRows = rowsState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var msgState = React.useState(null)
      var msg = msgState[0]
      var setMsg = msgState[1]
      var pathState = React.useState(null)
      var path = pathState[0]
      var setPath = pathState[1]
      var defaultsState = React.useState(null)
      var defaults = defaultsState[0]
      var setDefaults = defaultsState[1]
      var fallbackState = React.useState(null)
      var fallbackJson = fallbackState[0]
      var setFallbackJson = fallbackState[1]
      var newKeyState = React.useState('')
      var newKey = newKeyState[0]
      var setNewKey = newKeyState[1]

      React.useEffect(function () {
        var alive = true
        fetch('/plugins/session-cost-meter/pricing')
          .then(function (r) { return r.json() })
          .then(function (v) {
            if (!alive || !v) return
            if (typeof v.currency === 'string' && v.currency) setCurrency(v.currency)
            if (typeof v.peakFrom === 'string' && v.peakFrom) setPeakFrom(v.peakFrom)
            if (v.defaults && typeof v.defaults === 'object') setDefaults(v.defaults)
            if (typeof v.path === 'string') setPath(v.path)
            var rs = []
            var models = v.models && typeof v.models === 'object' ? v.models : {}
            for (var k in models) {
              if (!Object.prototype.hasOwnProperty.call(models, k)) continue
              var m = models[k] || {}
              var off = m.offPeak || {}
              var peak = m.peak || {}
              rs.push({
                key: k, input: numStr(m.input), cacheHit: numStr(m.cacheHit), output: numStr(m.output),
                oInput: numStr(off.input), oCacheHit: numStr(off.cacheHit), oOutput: numStr(off.output),
                pInput: numStr(peak.input), pCacheHit: numStr(peak.cacheHit), pOutput: numStr(peak.output),
              })
            }
            setRows(rs)
            if (v.fileExists === false) setMsg({ kind: 'info', text: '当前使用内置默认价（尚未保存过配置文件）' })
            else if (v.warning) setMsg({ kind: 'info', text: '配置文件无法解析，当前显示内置默认价：' + v.warning })
          })
          .catch(function (e) { if (alive) setMsg({ kind: 'err', text: String((e && e.message) || e) }) })
        return function () { alive = false }
      }, [])

      function updateRow(i, field, value) {
        setRows(function (prev) {
          return prev.map(function (r, j) {
            if (j !== i) return r
            var copy = {}
            for (var k2 in r) { if (Object.prototype.hasOwnProperty.call(r, k2)) copy[k2] = r[k2] }
            copy[field] = value
            return copy
          })
        })
      }
      function removeRow(i) {
        setRows(function (prev) { return prev.filter(function (r, j) { return j !== i }) })
      }
      function addRow() {
        var key = String(newKey).trim()
        if (!key) return
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].key === key) { setMsg({ kind: 'err', text: '模型名已存在' }); return }
        }
        setRows(function (prev) { return prev.concat([{ key: key, input: '1', cacheHit: '0.02', output: '2', oInput: '', oCacheHit: '', oOutput: '', pInput: '', pCacheHit: '', pOutput: '' }]) })
        setNewKey('')
      }
      function parseLine(r, a, b, c, label) {
        var anySet = String(r[a] || '').trim() !== '' || String(r[b] || '').trim() !== '' || String(r[c] || '').trim() !== ''
        if (!anySet) return null
        var va = Number(r[a])
        var vb = Number(r[b])
        var vc = Number(r[c])
        if (!Number.isFinite(va) || va < 0 || !Number.isFinite(vb) || vb < 0 || !Number.isFinite(vc) || vc < 0) throw new Error(label + ' 价格必须是 ≥0 的数字')
        return { input: va, cacheHit: vb, output: vc }
      }
      function collect() {
        var models = {}
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i]
          var key = String(r.key || '').trim()
          if (!key) throw new Error('存在空的模型名')
          var base = parseLine(r, 'input', 'cacheHit', 'output', '模型 ' + key + ' 的当前价')
          if (!base) throw new Error('模型 ' + key + ' 的当前价不能为空')
          var off = parseLine(r, 'oInput', 'oCacheHit', 'oOutput', '模型 ' + key + ' 的闲时价')
          var peak = parseLine(r, 'pInput', 'pCacheHit', 'pOutput', '模型 ' + key + ' 的高峰价')
          var m = { input: base.input, cacheHit: base.cacheHit, output: base.output }
          if (off) m.offPeak = off
          if (peak) m.peak = peak
          models[key] = m
        }
        if (Object.keys(models).length === 0) throw new Error('至少需要一个模型条目')
        var cur = String(currency || '').trim()
        if (!cur) throw new Error('币种不能为空')
        var pf = String(peakFrom || '').trim()
        if (pf && !Number.isFinite(Date.parse(pf))) throw new Error('生效时间格式无效（留空=不启用峰谷价）')
        return { currency: cur, peakFrom: pf, models: models }
      }
      function save() {
        var payload
        try { payload = collect() } catch (e) { setMsg({ kind: 'err', text: String((e && e.message) || e) }); return }
        setBusy(true)
        setFallbackJson(null)
        fetch('/plugins/session-cost-meter/pricing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json() })
          .then(function (v) {
            setBusy(false)
            if (v && v.ok) {
              if (v.path) setPath(v.path)
              setMsg({ kind: 'ok', text: '已保存。历史总计已按新价格全部重算，下一轮回复生效。' })
            } else {
              setMsg({ kind: 'err', text: v && v.error ? v.error : '保存失败' })
              if (v && v.json) setFallbackJson(v.json)
            }
          })
          .catch(function (e) { setBusy(false); setMsg({ kind: 'err', text: String((e && e.message) || e) }) })
      }
      function resetDefaults() {
        if (!defaults) return
        setCurrency(String(defaults.currency || 'CNY'))
        setPeakFrom(String(defaults.peakFrom || ''))
        var rs = []
        var models = defaults.models && typeof defaults.models === 'object' ? defaults.models : {}
        for (var k in models) {
          if (!Object.prototype.hasOwnProperty.call(models, k)) continue
          var m = models[k] || {}
          var off = m.offPeak || {}
          var peak = m.peak || {}
          rs.push({
            key: k, input: numStr(m.input), cacheHit: numStr(m.cacheHit), output: numStr(m.output),
            oInput: numStr(off.input), oCacheHit: numStr(off.cacheHit), oOutput: numStr(off.output),
            pInput: numStr(peak.input), pCacheHit: numStr(peak.cacheHit), pOutput: numStr(peak.output),
          })
        }
        setRows(rs)
        setMsg(null)
        setFallbackJson(null)
      }

      function priceInputs(r, i, prefix, pIn, pCache, pOut) {
        return React.createElement('div', { className: 'cm-row' },
          React.createElement('span', { className: 'cm-cell cm-model cm-line-label' }, prefix),
          React.createElement('input', { className: 'cm-cell', type: 'number', min: '0', step: 'any', value: r[pIn], placeholder: '输入', onChange: function (e) { updateRow(i, pIn, e.target.value) } }),
          React.createElement('input', { className: 'cm-cell', type: 'number', min: '0', step: 'any', value: r[pCache], placeholder: '缓存命中', onChange: function (e) { updateRow(i, pCache, e.target.value) } }),
          React.createElement('input', { className: 'cm-cell', type: 'number', min: '0', step: 'any', value: r[pOut], placeholder: '输出', onChange: function (e) { updateRow(i, pOut, e.target.value) } }),
          React.createElement('span', { className: 'cm-cell cm-del' }, '')
        )
      }
      var rowEls = rows.map(function (r, i) {
        var line1 = React.createElement('div', { className: 'cm-row' },
          React.createElement('input', { className: 'cm-cell cm-model', value: r.key, placeholder: '模型 ID', title: '模型 ID（如 deepseek-v4-pro）；* 表示其他模型', onChange: function (e) { updateRow(i, 'key', e.target.value) } }),
          React.createElement('input', { className: 'cm-cell', type: 'number', min: '0', step: 'any', value: r.input, placeholder: '输入', onChange: function (e) { updateRow(i, 'input', e.target.value) } }),
          React.createElement('input', { className: 'cm-cell', type: 'number', min: '0', step: 'any', value: r.cacheHit, placeholder: '缓存命中', onChange: function (e) { updateRow(i, 'cacheHit', e.target.value) } }),
          React.createElement('input', { className: 'cm-cell', type: 'number', min: '0', step: 'any', value: r.output, placeholder: '输出', onChange: function (e) { updateRow(i, 'output', e.target.value) } }),
          React.createElement('button', { className: 'cm-del', type: 'button', title: '删除该行', onClick: function () { removeRow(i) } }, '×')
        )
        var line2 = priceInputs(r, i, '8.17起·闲时', 'oInput', 'oCacheHit', 'oOutput')
        var line3 = priceInputs(r, i, '8.17起·高峰', 'pInput', 'pCacheHit', 'pOutput')
        return React.createElement('div', { key: r.key + ':' + i, className: 'cm-model-block' }, line1, line2, line3)
      })

      var head = React.createElement('div', { className: 'cm-row cm-head' },
        React.createElement('span', { className: 'cm-cell cm-model' }, '模型'),
        React.createElement('span', { className: 'cm-cell' }, '输入(未命中)'),
        React.createElement('span', { className: 'cm-cell' }, '输入(缓存命中)'),
        React.createElement('span', { className: 'cm-cell' }, '输出'),
        React.createElement('span', { className: 'cm-cell cm-del' }, '')
      )

      return React.createElement('div', { className: 'cm-settings' },
        React.createElement('h3', null, '会话费用计费标准'),
        React.createElement('p', { className: 'cm-hint' }, '价格单位：币种 / 每 100 万 token。默认已按官方定价页预填：当前价 + 2026-08-17 起的峰谷价（高峰=北京时间 9:00–12:00、14:00–18:00，闲时=高峰一半）。每条消息按发送时间自动套用对应价格。'),
        React.createElement('div', { className: 'cm-row' },
          React.createElement('span', { className: 'cm-cell cm-model' }, '币种'),
          React.createElement('input', { className: 'cm-cell', value: currency, maxLength: 12, placeholder: 'CNY / USD', title: '币种代码，如 CNY、USD', onChange: function (e) { setCurrency(e.target.value) } })
        ),
        React.createElement('div', { className: 'cm-row' },
          React.createElement('span', { className: 'cm-cell cm-model' }, '峰谷价生效时间'),
          React.createElement('input', { className: 'cm-cell', value: peakFrom, placeholder: '留空=不启用峰谷价', title: 'ISO 时间。之前按“当前价”计，之后按闲时/高峰价自动套用', onChange: function (e) { setPeakFrom(e.target.value) } })
        ),
        head,
        rowEls,
        React.createElement('div', { className: 'cm-row' },
          React.createElement('input', { className: 'cm-cell cm-model', value: newKey, placeholder: '新模型 ID', onChange: function (e) { setNewKey(e.target.value) } }),
          React.createElement('button', { type: 'button', onClick: addRow }, '添加模型')
        ),
        React.createElement('div', { className: 'cm-row' },
          React.createElement('button', { type: 'button', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          React.createElement('button', { type: 'button', onClick: resetDefaults }, '恢复官方默认')
        ),
        msg ? React.createElement('p', { className: 'cm-msg cm-' + msg.kind }, msg.text) : null,
        fallbackJson ? React.createElement('div', null,
          React.createElement('p', { className: 'cm-hint' }, '自动写入失败。请手动把下面的内容保存到文件 ' + (path || '.dsh-cost.json') + '：'),
          React.createElement('textarea', { className: 'cm-json', readOnly: true, value: fallbackJson })
        ) : null,
        path ? React.createElement('p', { className: 'cm-hint' }, '配置文件：' + path) : null
      )
    }

    function apply(ctx) {
      var style = document.createElement('style')
      style.textContent = SETTINGS_CSS
      document.head.appendChild(style)
      ctx.effect(function () {
        return function () {
          if (style.parentNode) style.parentNode.removeChild(style)
        }
      })
      var slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('conversation.session.header.utilities', function () {
        return slots.register(
          { name: 'conversation.session.header.utilities', id: 'session-cost-meter', order: 100, label: '会话费用' },
          function (props) { return React.createElement(Meter, props) }
        )
      })
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'cost-meter-pricing', order: 100, label: '会话费用计费' },
          function (props) { return React.createElement(PricingSettings, props) }
        )
      })
    }

    exports.name = 'session-cost-meter'
    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
