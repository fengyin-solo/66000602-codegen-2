// 确定性的 Solidity Gas 静态估算器。
// 不依赖运行时采集：按函数体中的写法（storage 写 / storage 读 /
// 循环内 storage 读 / 内部转账 / 事件 / require 等）结构化累加，
// 因此图表与列表中的消耗对比可以直接和循环、存储读写等写法对应。

export interface GasBreakdown {
  /** 基础开销（函数栈、参数处理等） */
  base: number
  /** SSTORE：storage 状态写入 */
  sstore: number
  /** SLOAD：storage 状态读取（循环内的读取按 LOOP_STORAGE_MULTIPLIER 倍计） */
  sload: number
  /** 循环内 storage 读取相对普通读取额外产生的开销 */
  loopStorage: number
  /** 内部转账 call/send/transfer */
  transfer: number
  /** 事件 emit */
  event: number
  /** require/assert 校验 */
  check: number
}

export interface GasSuggestion {
  /** 命中的写法，例如 "循环中读取storage变量" */
  issue: string
  /** 该写法对应的优化建议 */
  suggestion: string
  /** 命中次数 */
  count: number
}

export type FunctionKind =
  | "function"
  | "constructor"
  | "receive"
  | "fallback"

export type NoDataReason =
  | "abstract" // 只有声明没有函数体（接口/抽象函数），静态分析无法估算
  | "empty" // 空函数体，没有任何可统计的执行逻辑
  | "builtin" // receive/fallback 等框架函数，Gas 随运行时入参变化，无法静态估算

export interface FunctionGasReport {
  /** 带括号的展示名，例如 deposit()、withdraw(uint256)、receive() */
  name: string
  /** 函数裸名，用于逐函数阈值匹配 */
  shortName: string
  kind: FunctionKind
  line: number
  /** 是否存在可估算的函数体 */
  hasBody: boolean
  /** 无法采集消耗时的原因；为 null 表示有正常消耗数据 */
  noDataReason: NoDataReason | null
  /** 各项写法的命中次数（与消耗构成一一对应，用于解释"为什么是这个数"） */
  metrics: {
    storageWrites: number
    storageReads: number
    loopStorageReads: number
    transfers: number
    events: number
    checks: number
    loops: number
  }
  /** 各项写法贡献的 Gas 构成（合计 = currentGas） */
  breakdown: GasBreakdown
  /** 当前估算 Gas；无数据时为 null（绝不显示成 0） */
  currentGas: number | null
  /** 优化后估算 Gas；无数据时为 null */
  optimizedGas: number | null
  /** 原有优化建议：没有命中任何优化点时为固定文案，保证字段稳定 */
  suggestions: GasSuggestion[]
  suggestionText: string
}

// ---- 结构化单位成本（口径对全项目统一） ------------------------------------
export const GAS_UNITS = {
  BASE: 2000,
  SSTORE: 20000,
  SLOAD: 2100,
  /** 每次内部转账的基础开销 */
  TRANSFER: 9000,
  /** 单个事件的基础开销 */
  EVENT: 1500,
  /** 每次 require/assert 校验 */
  CHECK: 500,
  /** 最低保底，避免只有极少量写法时结果过小 */
  MIN_TOTAL: 2500,
} as const

/** 循环内 storage 读取按 3 次读取计入（循环展开的确定性近似） */
export const LOOP_STORAGE_MULTIPLIER = 3

// ---- 代码预处理 -----------------------------------------------------------

/** 去掉行/块注释，避免注释中的文字污染统计 */
export function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, m => m.replace(/[^\n]/g, " "))
}

/** 收集合约级 storage 状态变量名（mapping / 普通状态变量） */
export function extractStateVarNames(code: string): Set<string> {
  const names = new Set<string>()
  // mapping(address => uint256) public balances;
  const mappingRe = /mapping\s*\([^)]*\)\s*(?:public|private|internal|public)?\s*(\w+)\s*;/g
  // 简单变量声明：[type] [visibility] name [= ...];
  // 排除 function/constructor 等关键字开头的行
  const varRe =
    /(?:^|[;{}]\s*)(?:uint\d*|int\d*|bool|address|string|bytes\d*|\w+)\s+(?:public|private|internal|constant|immutable)*\s*(\w+)\s*(?:=[^;]*)?;/g

  let m: RegExpExecArray | null
  while ((m = mappingRe.exec(code))) names.add(m[1])
  while ((m = varRe.exec(code))) {
    const name = m[1]
    if (
      name &&
      !["contract", "interface", "library", "function", "return", "returns"].includes(name)
    ) {
      names.add(name)
    }
  }
  return names
}

interface RawFunction {
  kind: FunctionKind
  shortName: string
  displayName: string
  line: number
  /** 头部之后到分号/花括号之间的字符串 */
  body: string
  hasBody: boolean
}

/** 提取合约中的函数（含 constructor / receive / fallback），基于花括号配对取函数体 */
export function extractFunctions(code: string): RawFunction[] {
  const fns: RawFunction[] = []
  // 头部：function name(params) ... / constructor(params) ... / receive() ... / fallback() ...
  const headerRe =
    /\b(function\s+(\w+)|constructor|receive|fallback)\s*(?:\(([^)]*)\))?/g
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(code))) {
    const head = m[0]
    let kind: FunctionKind = "function"
    let shortName: string
    if (m[1] === "constructor") {
      kind = "constructor"
      shortName = "constructor"
    } else if (m[1] === "receive") {
      kind = "receive"
      shortName = "receive"
    } else if (m[1] === "fallback") {
      kind = "fallback"
      shortName = "fallback"
    } else {
      shortName = m[2]
    }
    if (!shortName) continue
    const params = (m[3] ?? "").trim()

    const after = code.slice(m.index + head.length)
    const braceIdx = after.indexOf("{")
    const semiIdx = after.indexOf(";")

    const line = code.slice(0, m.index).split("\n").length

    // 抽象/接口函数：分号出现在函数体之前
    if (semiIdx !== -1 && (braceIdx === -1 || semiIdx < braceIdx)) {
      fns.push({
        kind,
        shortName,
        displayName: kind === "function" ? `${shortName}(${params})` : `${shortName}()`,
        line,
        body: "",
        hasBody: false,
      })
      continue
    }
    if (braceIdx === -1) {
      fns.push({
        kind,
        shortName,
        displayName: kind === "function" ? `${shortName}(${params})` : `${shortName}()`,
        line,
        body: "",
        hasBody: false,
      })
      continue
    }

    // 花括号配对截取函数体
    let depth = 0
    let end = -1
    for (let i = braceIdx; i < after.length; i++) {
      if (after[i] === "{") depth++
      else if (after[i] === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const body = end === -1 ? after.slice(braceIdx + 1) : after.slice(braceIdx + 1, end)
    fns.push({
      kind,
      shortName,
      displayName: kind === "function" ? `${shortName}(${params})` : `${shortName}()`,
      line,
      body,
      hasBody: true,
    })
    // 移动 lastIndex，避免重复匹配
    headerRe.lastIndex = m.index + head.length + braceIdx + (end === -1 ? 1 : end + 1)
  }
  return fns
}

/** 找出循环体（for/while 紧跟的花括号块，或单条语句） */
function extractLoopBodies(body: string): string[] {
  const loops: string[] = []
  const loopRe = /\b(?:for|while)\s*\([^)]*\)/g
  let m: RegExpExecArray | null
  while ((m = loopRe.exec(body))) {
    const rest = body.slice(m.index + m[0].length)
    const braceIdx = rest.indexOf("{")
    if (braceIdx === 0 || (braceIdx !== -1 && /^\s*$/.test(rest.slice(0, braceIdx)))) {
      let depth = 0
      let end = -1
      for (let i = braceIdx; i < rest.length; i++) {
        if (rest[i] === "{") depth++
        else if (rest[i] === "}") {
          depth--
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      loops.push(end === -1 ? rest.slice(braceIdx + 1) : rest.slice(braceIdx + 1, end))
    } else {
      // 无花括号单语句循环体
      const semi = rest.indexOf(";")
      loops.push(semi === -1 ? rest : rest.slice(0, semi))
    }
  }
  return loops
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) || []).length
}

/** 统计单个函数体内的结构化写法并生成报告 */
function analyzeFunction(
  fn: RawFunction,
  stateVars: Set<string>,
): FunctionGasReport {
  const baseReport: FunctionGasReport = {
    name: fn.displayName,
    shortName: fn.shortName,
    kind: fn.kind,
    line: fn.line,
    hasBody: fn.hasBody,
    noDataReason: null,
    metrics: {
      storageWrites: 0,
      storageReads: 0,
      loopStorageReads: 0,
      transfers: 0,
      events: 0,
      checks: 0,
      loops: 0,
    },
    breakdown: { base: 0, sstore: 0, sload: 0, loopStorage: 0, transfer: 0, event: 0, check: 0 },
    currentGas: null,
    optimizedGas: null,
    suggestions: [],
    suggestionText: "",
  }

  // 1) 没有函数体：接口/抽象函数，静态分析无法估算
  if (!fn.hasBody) {
    return { ...baseReport, noDataReason: "abstract" }
  }

  // 2) receive/fallback：执行路径完全由运行时输入决定，不给确定性数值
  if (fn.kind === "receive" || fn.kind === "fallback") {
    return { ...baseReport, noDataReason: "builtin" }
  }

  const body = fn.body
  const loopBodies = extractLoopBodies(body)
  const loopText = loopBodies.join("\n")

  // ---- storage 写：varName = ...、varName += ...、++/--，以及 mapping 赋值
  let storageWrites = 0
  let loopStorageWrites = 0
  const countStorageWrites = (text: string): number => {
    let n = 0
    for (const v of stateVars) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      // balances[...] = / balances[...] += / balances++ / balances--
      n += countMatches(text, new RegExp(`${escaped}\\s*(?:\\[[^\\]]*\\])?\\s*(?:\\+\\+|--|=(?!=)|\\+=|-=|\\*=|\\/=)`, "g"))
    }
    return n
  }
  storageWrites = countStorageWrites(body)
  loopStorageWrites = loopBodies.reduce((acc, lb) => acc + countStorageWrites(lb), 0)

  // ---- storage 读：对状态变量的任何引用
  const countStorageRefs = (text: string): number => {
    let n = 0
    for (const v of stateVars) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      n += countMatches(text, new RegExp(`\\b${escaped}\\b`, "g"))
    }
    return n
  }
  const totalStorageRefs = countStorageRefs(body)
  const loopStorageRefs = loopBodies.reduce((acc, lb) => acc + countStorageRefs(lb), 0)
  // 读次数 = 总引用 - 写引用（写动作本身不算读；复合赋值 += 含一次读，下面补回）
  let compoundInLoop = 0
  for (const v of stateVars) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    compoundInLoop += countMatches(
      loopText,
      new RegExp(`${escaped}\\s*(?:\\[[^\\]]*\\])?\\s*(?:\\+=|-=|\\*=|\\/=|\\+\\+|--)`, "g"),
    )
  }
  const compoundWritesTotal = (() => {
    let n = 0
    for (const v of stateVars) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      n += countMatches(
        body,
        new RegExp(`${escaped}\\s*(?:\\[[^\\]]*\\])?\\s*(?:\\+=|-=|\\*=|\\/=|\\+\\+|--)`, "g"),
      )
    }
    return n
  })()
  // 普通读 = 总引用 - 写次数 + 复合写带来的隐式读
  let storageReads = totalStorageRefs - storageWrites + compoundWritesTotal
  let loopStorageReads = loopStorageRefs - loopStorageWrites + compoundInLoop
  storageReads = Math.max(0, storageReads)
  loopStorageReads = Math.max(0, loopStorageReads)
  // 循环内的读从普通读中扣除，单独按倍率计
  const normalStorageReads = Math.max(0, storageReads - loopStorageReads)

  // ---- 内部转账
  const transfers =
    countMatches(body, /\.call\s*\{/g) +
    countMatches(body, /\.transfer\s*\(/g) +
    countMatches(body, /\.send\s*\(/g)

  // ---- 事件
  const events = countMatches(body, /\bemit\s+\w+/g)

  // ---- 校验
  const checks = countMatches(body, /\b(?:require|assert)\s*\(/g)

  // 3) 空函数体（没有任何可统计的执行逻辑）
  const hasLogic =
    storageWrites > 0 ||
    normalStorageReads > 0 ||
    loopStorageReads > 0 ||
    transfers > 0 ||
    events > 0 ||
    checks > 0
  if (!hasLogic && body.trim().length === 0) {
    return { ...baseReport, noDataReason: "empty" }
  }

  // ---- 结构化成本
  const sstoreGas = storageWrites * GAS_UNITS.SSTORE
  const sloadGas = normalStorageReads * GAS_UNITS.SLOAD
  const loopStorageGas =
    loopStorageReads * GAS_UNITS.SLOAD * (LOOP_STORAGE_MULTIPLIER - 1)
  const transferGas = transfers * GAS_UNITS.TRANSFER
  const eventGas = events * GAS_UNITS.EVENT
  const checkGas = checks * GAS_UNITS.CHECK
  let currentGas =
    GAS_UNITS.BASE + sstoreGas + sloadGas + loopStorageGas + transferGas + eventGas + checkGas
  currentGas = Math.max(GAS_UNITS.MIN_TOTAL, currentGas)

  // ---- 优化建议（沿用原有 issue 文案体系，按命中的写法确定性生成）
  const suggestions: GasSuggestion[] = []
  if (loopStorageReads > 0) {
    suggestions.push({
      issue: "循环中读取storage变量",
      suggestion: "将循环中使用的 storage 变量缓存到 memory，避免每轮重复 SLOAD",
      count: loopStorageReads,
    })
  }
  if (storageWrites > 0) {
    suggestions.push({
      issue: "不必要的storage写入",
      suggestion: "移除不必要的 storage 写入，或在内存中聚合后一次性写回",
      count: storageWrites,
    })
  }
  if (checks >= 2) {
    suggestions.push({
      issue: "逻辑运算可短路优化",
      suggestion: "多个 require/条件按成本从低到高排列，利用短路逻辑减少计算",
      count: checks,
    })
  }
  if (transfers > 0) {
    suggestions.push({
      issue: "内部转账开销",
      suggestion: "合并批量转账、避免在循环中逐笔转账",
      count: transfers,
    })
  }
  if (events > 1) {
    suggestions.push({
      issue: "事件可合并",
      suggestion: "合并多个事件为一个，减少 LOG 操作开销",
      count: events,
    })
  }
  const suggestionText =
    suggestions.length > 0
      ? suggestions.map(s => `${s.suggestion}（${s.issue}×${s.count}）`).join("；")
      : "未发现明显的 Gas 优化点"

  // ---- 优化后 Gas：按可优化项折减
  let optimizedGas = currentGas
  if (loopStorageReads > 0) {
    // 循环内读缓存到 memory：额外倍率开销全部省掉
    optimizedGas -= loopStorageGas
  }
  if (storageWrites > 0) {
    // 写入优化：每个 SSTORE 节省约 30%
    optimizedGas -= Math.round(sstoreGas * 0.3)
  }
  if (checks >= 2) optimizedGas -= Math.round(checkGas * 0.4)
  if (events > 1) optimizedGas -= Math.round(eventGas * 0.3)
  optimizedGas = Math.max(GAS_UNITS.MIN_TOTAL, optimizedGas)

  return {
    ...baseReport,
    noDataReason: null,
    metrics: {
      storageWrites,
      storageReads: normalStorageReads,
      loopStorageReads,
      transfers,
      events,
      checks,
      loops: loopBodies.length,
    },
    breakdown: {
      base: GAS_UNITS.BASE,
      sstore: sstoreGas,
      sload: sloadGas,
      loopStorage: loopStorageGas,
      transfer: transferGas,
      event: eventGas,
      check: checkGas,
    },
    currentGas,
    optimizedGas,
    suggestions,
    suggestionText,
  }
}

/** 分析整份合约，返回每个函数的 Gas 报告（顺序与源码一致） */
export function analyzeGas(code: string): FunctionGasReport[] {
  const clean = stripComments(code)
  const stateVars = extractStateVarNames(clean)
  const fns = extractFunctions(clean)
  return fns.map(fn => analyzeFunction(fn, stateVars))
}

export const NO_DATA_REASON_TEXT: Record<NoDataReason, string> = {
  abstract: "该函数只有声明没有实现（接口/抽象函数），无执行路径，未采集到 Gas 消耗数据",
  empty: "函数体为空，没有可统计的执行逻辑，未采集到 Gas 消耗数据",
  builtin: "receive/fallback 的 Gas 随运行时输入变化，静态分析无法确定，未采集到消耗数据",
}
