import type { GasFeatures, GasMeasurement, GasNoDataEntry, GasIssue } from '@/types'
import { GAS_RULES } from './gasBudget'

/**
 * 确定性 Gas 静态估算（与后端 app/main.py 的 analyze_gas 保持一致）。
 * 依据代码写法估算：循环（含可解析的迭代次数）会放大体内消耗，
 * 存储读写、外部调用、事件日志等按次数累计。
 * 没有函数体的声明（接口/抽象函数）无法估算，列入 noData 并说明原因，不计为 0。
 */

type Feats = Pick<
  GasFeatures,
  'storageReads' | 'storageWrites' | 'externalCalls' | 'emits' | 'keccak' | 'arithOps'
>

const FUNC_RE = /function\s+(\w+)\s*\(([^)]*)\)([^{;]*)(\{|;)/g
const LOOP_RE = /\bfor\s*\(|\bwhile\s*\(|\bdo\s*\{/g
const STATE_DECL_RE =
  /\b(?:mapping\s*\((?:[^()]|\([^()]*\))*\)|u?int\d*|address|bool|bytes\d*|string)(?:\s*\[\s*\d*\s*\])*((?:\s+(?:public|private|internal|constant|immutable|override))*)\s+(\w+)\s*(?:=[^;]*)?;/g

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function matchPair(code: string, openIdx: number, openCh: string, closeCh: string): number {
  let depth = 0
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === openCh) depth++
    else if (code[i] === closeCh) {
      depth--
      if (depth === 0) return i
    }
  }
  return code.length - 1
}

function collectStateVars(code: string): string[] {
  let masked = code
  FUNC_RE.lastIndex = 0
  for (const m of code.matchAll(FUNC_RE)) {
    if (m[4] === '{') {
      const openIdx = m.index! + m[0].length - 1
      const end = matchPair(code, openIdx, '{', '}')
      masked = masked.replace(code.slice(m.index!, end + 1), ' ')
    }
  }
  masked = masked
    .replace(/\bmodifier\s+\w*\s*\([^)]*\)[^{]*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, ' ')
    .replace(/\b(struct|enum)\s+\w+\s*\{[^{}]*\}/g, ' ')
    .replace(/\bevent\s+\w+\s*\([^)]*\)\s*(anonymous\s*)?;/g, ' ')

  const names: string[] = []
  for (const m of masked.matchAll(STATE_DECL_RE)) {
    const mods = m[1] || ''
    if (mods.includes('constant') || mods.includes('immutable')) continue
    names.push(m[2])
  }
  return names
}

function countFeatures(seg: string, stateVars: string[]): Feats {
  const feats: Feats = { storageReads: 0, storageWrites: 0, externalCalls: 0, emits: 0, keccak: 0, arithOps: 0 }
  for (const name of stateVars) {
    const writes = (seg.match(new RegExp(`\\b${name}\\b(?:\\s*\\[[^\\]]*\\]|\\s*\\.\\s*\\w+)*\\s*(?:[+\\-*/%|&^]?=|\\+\\+|--)`, 'g')) || []).length
    const deletes = (seg.match(new RegExp(`\\bdelete\\s+${name}\\b`, 'g')) || []).length
    const total = (seg.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length
    feats.storageWrites += writes + deletes
    feats.storageReads += Math.max(0, total - writes - deletes)
  }
  feats.externalCalls = (seg.match(/\.(?:call|delegatecall|staticcall)\s*(?:\{[^{}]*\})?\s*\(|\.(?:transfer|send)\s*\(|\bnew\s+\w+\s*\(/g) || []).length
  feats.emits = (seg.match(/\bemit\s+\w+/g) || []).length
  feats.keccak = (seg.match(/\bkeccak256\s*\(/g) || []).length
  feats.arithOps = (seg.match(/(?<![+\-*/%=<>&|!])[+\-*/%](?![+\-*/%=])/g) || []).length
  return feats
}

function parseLoopIters(header: string): number {
  let m = header.match(/<=\s*(\d+)/)
  if (m) return Math.min(parseInt(m[1], 10) + 1, GAS_RULES.MAX_LOOP_ITERS)
  m = header.match(/<\s*(\d+)/)
  if (m) return Math.min(Math.max(parseInt(m[1], 10), 1), GAS_RULES.MAX_LOOP_ITERS)
  return GAS_RULES.DEFAULT_LOOP_ITERS
}

interface LoopInfo {
  start: number
  end: number
  iters: number
  body: string
}

function findTopLoops(seg: string): LoopInfo[] {
  const loops: LoopInfo[] = []
  let pos = 0
  LOOP_RE.lastIndex = 0
  while (true) {
    LOOP_RE.lastIndex = pos
    const m = LOOP_RE.exec(seg)
    if (!m) break
    const token = m[0]
    if (token.startsWith('do')) {
      const openIdx = seg.indexOf('{', m.index)
      const closeIdx = matchPair(seg, openIdx, '{', '}')
      let end = closeIdx + 1
      const tail = seg.slice(end).match(/^\s*while\s*\(/)
      if (tail) {
        // do { } while (...); 的 while 部分不再单独算循环
        const parenOpen = end + tail[0].indexOf('(')
        end = matchPair(seg, parenOpen, '(', ')') + 1
        const semi = seg.slice(end).match(/^\s*;/)
        if (semi) end += semi[0].length
      }
      loops.push({ start: m.index, end, iters: GAS_RULES.DEFAULT_LOOP_ITERS, body: seg.slice(openIdx + 1, closeIdx) })
      pos = end
    } else {
      const parenOpen = seg.indexOf('(', m.index)
      const parenClose = matchPair(seg, parenOpen, '(', ')')
      const header = seg.slice(parenOpen + 1, parenClose)
      const iters = token.startsWith('for') ? parseLoopIters(header) : GAS_RULES.DEFAULT_LOOP_ITERS
      let j = parenClose + 1
      while (j < seg.length && ' \t\r\n'.includes(seg[j])) j++
      let body: string
      let end: number
      if (j < seg.length && seg[j] === '{') {
        const closeIdx = matchPair(seg, j, '{', '}')
        body = seg.slice(j + 1, closeIdx)
        end = closeIdx + 1
      } else {
        const semi = seg.indexOf(';', j)
        end = semi === -1 ? seg.length : semi + 1
        body = seg.slice(j, end)
      }
      loops.push({ start: m.index, end, iters, body })
      pos = end
    }
  }
  return loops
}

interface SegmentResult {
  feats: Feats
  loopFeats: Feats
  loopCount: number
  maxIters: number
}

function analyzeSegment(seg: string, stateVars: string[], useMultipliers = true): SegmentResult {
  const feats: Feats = { storageReads: 0, storageWrites: 0, externalCalls: 0, emits: 0, keccak: 0, arithOps: 0 }
  const loopFeats: Feats = { ...feats }
  let loopCount = 0
  let maxIters = 0
  let pos = 0
  const add = (dst: Feats, src: Feats, mult = 1) => {
    ;(Object.keys(dst) as (keyof Feats)[]).forEach((k) => {
      dst[k] += src[k] * mult
    })
  }
  for (const loop of findTopLoops(seg)) {
    add(feats, countFeatures(seg.slice(pos, loop.start), stateVars))
    const inner = analyzeSegment(loop.body, stateVars, useMultipliers)
    add(feats, inner.feats, useMultipliers ? loop.iters : 1)
    add(loopFeats, inner.loopFeats)
    add(loopFeats, countFeatures(loop.body, stateVars))
    loopCount += 1 + inner.loopCount
    maxIters = Math.max(maxIters, loop.iters, inner.maxIters)
    pos = loop.end
  }
  add(feats, countFeatures(seg.slice(pos), stateVars))
  return { feats, loopFeats, loopCount, maxIters }
}

function estimateGas(f: Feats): number {
  const r = GAS_RULES
  return (
    r.TX_BASE + r.FUNC_BASE +
    f.storageReads * r.SLOAD +
    f.storageWrites * r.SSTORE +
    f.externalCalls * r.CALL +
    f.emits * r.EMIT +
    f.keccak * r.KECCAK +
    f.arithOps * r.ARITH
  )
}

function pickSuggestion(feats: Feats, loopFeats: Feats, loopCount: number, body: string): string {
  if (loopCount && (loopFeats.storageReads || loopFeats.storageWrites)) return '缓存storage变量到memory'
  if (feats.storageWrites >= 2) return '移除不必要的storage写入'
  if (feats.emits >= 2) return '合并多个事件为一个'
  if (body.includes('&&') || body.includes('||')) return '使用短路逻辑'
  if (feats.storageReads) return '缓存storage变量到memory'
  return '使用短路逻辑'
}

export function analyzeContractGas(code: string): {
  measurements: GasMeasurement[]
  noData: GasNoDataEntry[]
  gasIssues: GasIssue[]
} {
  const clean = stripComments(code)
  const stateVars = collectStateVars(clean)
  const measurements: GasMeasurement[] = []
  const noData: GasNoDataEntry[] = []
  const gasIssues: GasIssue[] = []

  FUNC_RE.lastIndex = 0
  for (const m of clean.matchAll(FUNC_RE)) {
    const name = m[1]
    const line = clean.slice(0, m.index!).split('\n').length
    if (m[4] === ';') {
      noData.push({
        functionName: `${name}()`,
        name,
        line,
        reason: '仅为函数声明（接口或抽象函数），没有函数体，无法静态估算 Gas 消耗',
      })
      continue
    }
    const openIdx = m.index! + m[0].length - 1
    const body = clean.slice(openIdx + 1, matchPair(clean, openIdx, '{', '}'))
    const { feats, loopFeats, loopCount, maxIters } = analyzeSegment(body, stateVars)
    const flat = analyzeSegment(body, stateVars, false)
    const estimated = estimateGas(feats)
    const loopExtra = Math.max(0, estimated - estimateGas(flat.feats))

    const drivers = [
      feats.storageWrites ? { label: '存储写入', count: feats.storageWrites, gas: feats.storageWrites * GAS_RULES.SSTORE } : null,
      feats.storageReads ? { label: '存储读取', count: feats.storageReads, gas: feats.storageReads * GAS_RULES.SLOAD } : null,
      loopExtra > 0 ? { label: `循环迭代(×${maxIters})`, count: loopCount, gas: loopExtra } : null,
      feats.externalCalls ? { label: '外部调用', count: feats.externalCalls, gas: feats.externalCalls * GAS_RULES.CALL } : null,
      feats.emits ? { label: '事件日志', count: feats.emits, gas: feats.emits * GAS_RULES.EMIT } : null,
    ]
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .sort((a, b) => b.gas - a.gas)

    let savings = 0
    if (loopCount && maxIters > 1) {
      savings += loopFeats.storageReads * (maxIters - 1) * GAS_RULES.SLOAD
      savings += Math.floor(loopFeats.storageWrites * (maxIters - 1) * GAS_RULES.SSTORE * 0.5)
    }
    const optimized = Math.max(GAS_RULES.TX_BASE + GAS_RULES.FUNC_BASE, estimated - savings)

    measurements.push({
      name,
      functionName: `${name}()`,
      line,
      estimatedGas: estimated,
      optimizedGas: optimized,
      features: {
        storageReads: feats.storageReads,
        storageWrites: feats.storageWrites,
        loops: loopCount,
        maxLoopIters: maxIters,
        externalCalls: feats.externalCalls,
        emits: feats.emits,
        keccak: feats.keccak,
        arithOps: feats.arithOps,
      },
      drivers,
    })
    gasIssues.push({
      functionName: `${name}()`,
      currentGas: estimated,
      optimizedGas: optimized,
      suggestion: pickSuggestion(feats, loopFeats, loopCount, body),
    })
  }
  return { measurements, noData, gasIssues }
}
