from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import re
import uuid
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

app = FastAPI(title="Smart Contract Security Auditor")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# Vulnerability patterns
VULNERABILITY_PATTERNS = [
    {
        "type": "重入攻击 (Reentrancy)",
        "severity": "critical",
        "pattern": r"\.call\{[^}]*value:\s*[^}]*\}\([^)]*\)",
        "description": "使用低级call()或send()转移ETH存在重入攻击风险。攻击者可部署恶意合约在fallback中反复调用提款。",
        "suggestion": "使用Checks-Effects-Interactions模式，或引入ReentrancyGuard。推荐使用transfer()或call()并限制Gas。"
    },
    {
        "type": "整数溢出 (Integer Overflow/Underflow)",
        "severity": "high",
        "pattern": r"[+\-*/]\s*=|(&&|\|\|)\s*\w+\s*[<>=]",
        "description": "Solidity 0.7及以下版本，未使用SafeMath时可能发生整数溢出。",
        "suggestion": "使用SafeMath库或升级到Solidity 0.8+（内置溢出检查）。"
    },
    {
        "type": "未授权访问控制",
        "severity": "high",
        "pattern": r"function\s+\w+\s*\([^)]*\)\s*public\s*(payable)?\s*\{[^}]*(?:require|if)\s*\(",
        "description": "关键函数缺少访问控制检查，任何人都可以调用。",
        "suggestion": "添加onlyOwner或自定义访问控制修饰符。"
    },
    {
        "type": "selfdestruct使用",
        "severity": "medium",
        "pattern": r"selfdestruct|suicide",
        "description": "selfdestruct可强制将合约所有ETH发送到任意地址，可能被滥用。",
        "suggestion": "谨慎使用selfdestruct，确保有正当的业务需求。"
    },
    {
        "type": "tx.origin钓鱼",
        "severity": "high",
        "pattern": r"tx\.origin",
        "description": "使用tx.origin进行身份验证可能被钓鱼攻击，攻击者诱导用户触发交易。",
        "suggestion": "使用msg.sender代替tx.origin进行身份验证。"
    },
    {
        "type": "精确度损失",
        "severity": "medium",
        "pattern": r"/\s*\d+",
        "description": "除法运算可能导致精度损失，特别是在代币金额计算中。",
        "suggestion": "先乘后除，使用高精度计算或使用Babylonian方法。"
    },
]

GAS_PATTERNS = [
    {"function": "storage_read", "issue": "循环中读取storage变量", "saving": 0.3},
    {"function": "redundant_sstore", "issue": "不必要的storage写入", "saving": 0.25},
    {"function": "short_circuit", "issue": "逻辑运算可短路优化", "saving": 0.15},
]

# ---------------------------------------------------------------------------
# Gas 估算与预算规则（单一事实来源，前端 utils/gasBudget.ts 保持一致）
# ---------------------------------------------------------------------------
GAS_RULES = {
    # 估算成本常量（单位：gas）
    "TX_BASE": 21000,            # 一笔交易的基础成本
    "FUNC_BASE": 300,            # 函数调度与参数处理
    "SLOAD": 800,                # 一次 storage 读取（热槽）
    "SSTORE": 5000,              # 一次 storage 写入（非零槽平均值）
    "CALL": 2600,                # 一次外部调用
    "EMIT": 1500,                # 一次事件日志
    "KECCAK": 200,               # 一次 keccak256
    "ARITH": 20,                 # 一次算术运算（近似）
    "DEFAULT_LOOP_ITERS": 10,    # 无法解析循环边界时的默认迭代次数
    "MAX_LOOP_ITERS": 1000,      # 解析出的迭代次数上限
    # 预算阈值合法范围
    "MIN_LIMIT": 21000,          # 低于一笔基础交易的预算没有意义
    "MAX_LIMIT": 30000000,       # 以太坊区块 Gas Limit 约 3000 万
    "DEFAULT_WARNING_RATIO": 0.8,
}

BUDGET_RULE_DESCRIPTION = (
    "判定规则：函数估算消耗 > 适用上限 判定为超标；"
    "估算消耗 ≥ 适用上限 × 预警比例（默认 0.8）判定为接近阈值并提醒；其余为正常。"
    "适用上限优先取该函数的单独阈值，未设置时使用项目默认上限；两者都未设置记为未设限。"
    "阈值合法范围为 [21000, 30000000] 的整数（21000 为基础交易成本，30000000 约为区块 Gas Limit），"
    "超出范围的取值会被拦截并说明原因，其余合法条目仍然生效。"
    "预警比例必须在 (0, 1) 开区间内。"
)

STATE_DECL_RE = re.compile(
    r"\b(?:mapping\s*\((?:[^()]|\([^()]*\))*\)|u?int\d*|address|bool|bytes\d*|string)"
    r"(?:\s*\[\s*\d*\s*\])*"
    r"(?P<mods>(?:\s+(?:public|private|internal|constant|immutable|override))*)\s+"
    r"(?P<name>\w+)\s*(?:=[^;]*)?;"
)
FUNC_RE = re.compile(r"function\s+(\w+)\s*\(([^)]*)\)([^{;]*)(\{|;)")
LOOP_RE = re.compile(r"\bfor\s*\(|\bwhile\s*\(|\bdo\s*\{")


def strip_comments(code: str) -> str:
    code = re.sub(r"/\*.*?\*/", "", code, flags=re.DOTALL)
    code = re.sub(r"//[^\n]*", "", code)
    return code


def match_pair(code: str, open_idx: int, open_ch: str = "{", close_ch: str = "}") -> int:
    depth = 0
    for i in range(open_idx, len(code)):
        if code[i] == open_ch:
            depth += 1
        elif code[i] == close_ch:
            depth -= 1
            if depth == 0:
                return i
    return len(code) - 1


def collect_state_vars(code: str) -> List[str]:
    """Collect state variable names declared at contract level (function bodies removed)."""
    masked = code
    # 去掉函数体 / modifier 体 / struct / enum / event，避免把局部变量当状态变量
    for m in FUNC_RE.finditer(code):
        if m.group(4) == "{":
            end = match_pair(code, m.end() - 1)
            masked = masked.replace(code[m.start():end + 1], " ")
    masked = re.sub(r"\bmodifier\s+\w*\s*\([^)]*\)[^{]*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}", " ", masked)
    masked = re.sub(r"\b(struct|enum)\s+\w+\s*\{[^{}]*\}", " ", masked)
    masked = re.sub(r"\bevent\s+\w+\s*\([^)]*\)\s*(anonymous\s*)?;", " ", masked)

    names = []
    for m in STATE_DECL_RE.finditer(masked):
        mods = m.group("mods") or ""
        if "constant" in mods or "immutable" in mods:
            continue  # constant/immutable 不产生 SLOAD
        names.append(m.group("name"))
    return names


def count_features(seg: str, state_vars: List[str]) -> Dict[str, int]:
    feats = {"storageReads": 0, "storageWrites": 0, "externalCalls": 0,
             "emits": 0, "keccak": 0, "arithOps": 0}
    for name in state_vars:
        writes = len(re.findall(
            rf"\b{name}\b(?:\s*\[[^\]]*\]|\s*\.\s*\w+)*\s*(?:[+\-*/%|&^]?=|\+\+|--)", seg))
        deletes = len(re.findall(rf"\bdelete\s+{name}\b", seg))
        total = len(re.findall(rf"\b{name}\b", seg))
        feats["storageWrites"] += writes + deletes
        feats["storageReads"] += max(0, total - writes - deletes)
    feats["externalCalls"] = len(re.findall(
        r"\.(?:call|delegatecall|staticcall)\s*(?:\{[^{}]*\})?\s*\(|\.(?:transfer|send)\s*\(|\bnew\s+\w+\s*\(", seg))
    feats["emits"] = len(re.findall(r"\bemit\s+\w+", seg))
    feats["keccak"] = len(re.findall(r"\bkeccak256\s*\(", seg))
    feats["arithOps"] = len(re.findall(r"(?<![+\-*/%=<>&|!])[+\-*/%](?![+\-*/%=])", seg))
    return feats


def parse_loop_iters(header: str) -> int:
    m = re.search(r"<=\s*(\d+)", header)
    if m:
        return min(int(m.group(1)) + 1, GAS_RULES["MAX_LOOP_ITERS"])
    m = re.search(r"<\s*(\d+)", header)
    if m:
        return min(max(int(m.group(1)), 1), GAS_RULES["MAX_LOOP_ITERS"])
    return GAS_RULES["DEFAULT_LOOP_ITERS"]


def find_top_loops(seg: str):
    """Find top-level loops; nested loops are handled by recursion into the body."""
    loops = []
    pos = 0
    while True:
        m = LOOP_RE.search(seg, pos)
        if not m:
            break
        token = m.group(0)
        if token.startswith("do"):
            open_idx = seg.index("{", m.start())
            close_idx = match_pair(seg, open_idx)
            end = close_idx + 1
            tail = re.match(r"\s*while\s*\(", seg[end:])
            if tail:  # do { } while (...); 的 while 部分不再单独算循环
                paren_open = end + tail.group(0).index("(")
                end = match_pair(seg, paren_open, "(", ")") + 1
                semi = re.match(r"\s*;", seg[end:])
                if semi:
                    end += semi.end()
            loops.append((m.start(), end, GAS_RULES["DEFAULT_LOOP_ITERS"], seg[open_idx + 1:close_idx]))
            pos = end
        else:
            paren_open = seg.index("(", m.start())
            paren_close = match_pair(seg, paren_open, "(", ")")
            header = seg[paren_open + 1:paren_close]
            iters = parse_loop_iters(header) if token.startswith("for") else GAS_RULES["DEFAULT_LOOP_ITERS"]
            j = paren_close + 1
            while j < len(seg) and seg[j] in " \t\r\n":
                j += 1
            if j < len(seg) and seg[j] == "{":
                close_idx = match_pair(seg, j)
                body, end = seg[j + 1:close_idx], close_idx + 1
            else:  # 单语句循环体
                semi = seg.find(";", j)
                end = (semi + 1) if semi != -1 else len(seg)
                body = seg[j:end]
            loops.append((m.start(), end, iters, body))
            pos = end
    return loops


def analyze_segment(seg: str, state_vars: List[str], use_multipliers: bool = True):
    """Return (weighted_feats, loop_feats, loop_count, max_iters).

    weighted_feats: 循环体内的消耗按迭代次数加权。
    loop_feats: 循环体内未加权的原始计数（用于生成优化建议）。
    """
    feats = {"storageReads": 0, "storageWrites": 0, "externalCalls": 0,
             "emits": 0, "keccak": 0, "arithOps": 0}
    loop_feats = dict(feats)
    loop_count, max_iters = 0, 0
    pos = 0
    for start, end, iters, body in find_top_loops(seg):
        plain = count_features(seg[pos:start], state_vars)
        for k in feats:
            feats[k] += plain[k]
        inner, inner_loop_feats, inner_loops, inner_max = analyze_segment(body, state_vars, use_multipliers)
        mult = iters if use_multipliers else 1
        for k in feats:
            feats[k] += inner[k] * mult
            loop_feats[k] += inner_loop_feats[k]
        body_feats = count_features(body, state_vars)
        for k in loop_feats:
            loop_feats[k] += body_feats[k]
        loop_count += 1 + inner_loops
        max_iters = max(max_iters, iters, inner_max)
        pos = end
    tail = count_features(seg[pos:], state_vars)
    for k in feats:
        feats[k] += tail[k]
    return feats, loop_feats, loop_count, max_iters


def estimate_gas(feats: Dict[str, int]) -> int:
    r = GAS_RULES
    return (r["TX_BASE"] + r["FUNC_BASE"]
            + feats["storageReads"] * r["SLOAD"]
            + feats["storageWrites"] * r["SSTORE"]
            + feats["externalCalls"] * r["CALL"]
            + feats["emits"] * r["EMIT"]
            + feats["keccak"] * r["KECCAK"]
            + feats["arithOps"] * r["ARITH"])


def build_drivers(feats: Dict[str, int], loop_extra: int, loop_count: int, max_iters: int) -> List[dict]:
    r = GAS_RULES
    drivers = []
    if feats["storageWrites"]:
        drivers.append({"label": "存储写入", "count": feats["storageWrites"], "gas": feats["storageWrites"] * r["SSTORE"]})
    if feats["storageReads"]:
        drivers.append({"label": "存储读取", "count": feats["storageReads"], "gas": feats["storageReads"] * r["SLOAD"]})
    if loop_extra > 0:
        drivers.append({"label": f"循环迭代(×{max_iters})", "count": loop_count, "gas": loop_extra})
    if feats["externalCalls"]:
        drivers.append({"label": "外部调用", "count": feats["externalCalls"], "gas": feats["externalCalls"] * r["CALL"]})
    if feats["emits"]:
        drivers.append({"label": "事件日志", "count": feats["emits"], "gas": feats["emits"] * r["EMIT"]})
    drivers.sort(key=lambda d: d["gas"], reverse=True)
    return drivers


def pick_suggestion(feats, loop_feats, loop_count, body) -> str:
    if loop_count and (loop_feats["storageReads"] or loop_feats["storageWrites"]):
        return "缓存storage变量到memory"
    if feats["storageWrites"] >= 2:
        return "移除不必要的storage写入"
    if feats["emits"] >= 2:
        return "合并多个事件为一个"
    if "&&" in body or "||" in body:
        return "使用短路逻辑"
    if feats["storageReads"]:
        return "缓存storage变量到memory"
    return "使用短路逻辑"


def analyze_gas(code: str):
    """Deterministically estimate gas per function from code structure.

    Returns (measurements, no_data, gas_issues).
    没有函数体的声明（接口/抽象函数）无法估算，列入 no_data 并说明原因，不计为 0。
    """
    clean = strip_comments(code)
    state_vars = collect_state_vars(clean)
    measurements, no_data, gas_issues = [], [], []

    for m in FUNC_RE.finditer(clean):
        name = m.group(1)
        line = clean[:m.start()].count("\n") + 1
        if m.group(4) == ";":
            no_data.append({
                "functionName": f"{name}()",
                "name": name,
                "line": line,
                "reason": "仅为函数声明（接口或抽象函数），没有函数体，无法静态估算 Gas 消耗",
            })
            continue
        body = clean[m.end():match_pair(clean, m.end() - 1)]
        feats, loop_feats, loop_count, max_iters = analyze_segment(body, state_vars)
        flat_feats, _, _, _ = analyze_segment(body, state_vars, use_multipliers=False)
        estimated = estimate_gas(feats)
        loop_extra = max(0, estimated - estimate_gas(flat_feats))
        drivers = build_drivers(feats, loop_extra, loop_count, max_iters)

        # 优化后估算：循环内存储读取缓存到 memory（只算一次），循环内存储写入减半
        r = GAS_RULES
        savings = 0
        if loop_count and max_iters > 1:
            savings += loop_feats["storageReads"] * (max_iters - 1) * r["SLOAD"]
            savings += int(loop_feats["storageWrites"] * (max_iters - 1) * r["SSTORE"] * 0.5)
        optimized = max(r["TX_BASE"] + r["FUNC_BASE"], estimated - savings)

        measurements.append({
            "name": name,
            "functionName": f"{name}()",
            "line": line,
            "estimatedGas": estimated,
            "optimizedGas": optimized,
            "features": {
                "storageReads": feats["storageReads"],
                "storageWrites": feats["storageWrites"],
                "loops": loop_count,
                "maxLoopIters": max_iters,
                "externalCalls": feats["externalCalls"],
                "emits": feats["emits"],
                "keccak": feats["keccak"],
                "arithOps": feats["arithOps"],
            },
            "drivers": drivers,
        })
        gas_issues.append({
            "functionName": f"{name}()",
            "currentGas": estimated,
            "optimizedGas": optimized,
            "suggestion": pick_suggestion(feats, loop_feats, loop_count, body),
        })
    return measurements, no_data, gas_issues


# ---------------------------------------------------------------------------
# Gas 预算：配置校验 + 评估
# ---------------------------------------------------------------------------
def normalize_fn_name(name: str) -> str:
    return re.sub(r"\(\s*\)$", "", str(name).strip())


def check_limit_value(value: Any):
    """校验单个阈值，返回 (ok, reason)。规则见 BUDGET_RULE_DESCRIPTION。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False, "阈值必须是数字（单位：gas）"
    if isinstance(value, float) and not value.is_integer():
        return False, "阈值必须是整数（单位：gas）"
    v = int(value)
    if v < GAS_RULES["MIN_LIMIT"]:
        return False, f"低于合理下限 {GAS_RULES['MIN_LIMIT']} gas：一笔基础转账交易即需 21000 gas，低于该值的预算没有实际意义"
    if v > GAS_RULES["MAX_LIMIT"]:
        return False, f"高于合理上限 {GAS_RULES['MAX_LIMIT']} gas：约为以太坊区块 Gas Limit，单笔交易不可能超过该值"
    return True, ""


def validate_budget_config(config: Optional[dict]):
    """返回 (valid_config, rejected)。非法条目被拦截并说明原因，合法条目保留生效。"""
    valid = {"defaultLimit": None, "functionLimits": {}, "warningRatio": GAS_RULES["DEFAULT_WARNING_RATIO"]}
    rejected = []
    config = config or {}

    default_limit = config.get("defaultLimit")
    if default_limit is not None:
        ok, reason = check_limit_value(default_limit)
        if ok:
            valid["defaultLimit"] = int(default_limit)
        else:
            rejected.append({"target": "defaultLimit", "value": default_limit, "reason": reason})

    for name, value in (config.get("functionLimits") or {}).items():
        ok, reason = check_limit_value(value)
        if ok:
            valid["functionLimits"][normalize_fn_name(name)] = int(value)
        else:
            rejected.append({"target": f"function:{name}", "value": value, "reason": reason})

    ratio = config.get("warningRatio")
    if ratio is not None:
        if isinstance(ratio, (int, float)) and not isinstance(ratio, bool) and 0 < ratio < 1:
            valid["warningRatio"] = float(ratio)
        else:
            rejected.append({"target": "warningRatio", "value": ratio,
                             "reason": "预警比例必须在 (0, 1) 开区间内，例如 0.8 表示达到上限 80% 时提醒"})
    return valid, rejected


def evaluate_budget(measurements: List[dict], no_data: List[dict], valid_config: dict) -> dict:
    """纯函数：同一份测量数据 + 同一份配置 => 同一份结果。

    调整阈值只改变判定口径，不改变已采集的消耗数据，因此原本正常的函数
    只有在其适用上限被调到低于其消耗时才会变为超标。
    """
    warning_ratio = valid_config.get("warningRatio") or GAS_RULES["DEFAULT_WARNING_RATIO"]
    entries = []
    for m in measurements:
        name = normalize_fn_name(m.get("name") or m.get("functionName", ""))
        fn_limits = valid_config.get("functionLimits") or {}
        if name in fn_limits:
            limit, source = fn_limits[name], "function"
        elif valid_config.get("defaultLimit") is not None:
            limit, source = valid_config["defaultLimit"], "default"
        else:
            limit, source = None, None

        entry = {
            "name": name,
            "functionName": m.get("functionName", f"{name}()"),
            "estimatedGas": m.get("estimatedGas"),
            "limit": limit,
            "limitSource": source,
            "ratio": None,
            "status": "unlimited",
            "exceedRatio": None,
            "reason": None,
            "drivers": m.get("drivers", []),
        }
        if limit is not None and m.get("estimatedGas") is not None:
            ratio = m["estimatedGas"] / limit
            entry["ratio"] = round(ratio, 4)
            if ratio > 1:
                entry["status"] = "exceeded"
                entry["exceedRatio"] = round((ratio - 1) * 100, 1)
                top = m.get("drivers", [])[:2]
                detail = "、".join(f"{d['label']}×{d['count']}(约{d['gas']} gas)" for d in top) or "基础交易成本高"
                src = "单独阈值" if source == "function" else "默认上限"
                entry["reason"] = f"超出{src} {limit} gas 的 {entry['exceedRatio']}%，主要消耗来自{detail}"
            elif ratio >= warning_ratio:
                entry["status"] = "warning"
            else:
                entry["status"] = "ok"
        entries.append(entry)

    exceeded = sorted((e for e in entries if e["status"] == "exceeded"),
                      key=lambda e: e["exceedRatio"], reverse=True)
    warnings = [e for e in entries if e["status"] == "warning"]
    return {
        "config": valid_config,
        "entries": entries,
        "exceeded": exceeded,
        "warnings": warnings,
        "noData": no_data,
        "rules": {"description": BUDGET_RULE_DESCRIPTION, **{k: v for k, v in GAS_RULES.items()}},
    }


class AuditRequest(BaseModel):
    code: str
    filename: str
    gasBudget: Optional[Dict[str, Any]] = None


class GasEvaluateRequest(BaseModel):
    measurements: List[Dict[str, Any]] = []
    noData: List[Dict[str, Any]] = []
    config: Optional[Dict[str, Any]] = None


def detect_vulnerabilities(code: str) -> List[dict]:
    """Scan code for vulnerability patterns"""
    lines = code.split("\n")
    vulnerabilities = []

    for vp in VULNERABILITY_PATTERNS:
        matches = re.finditer(vp["pattern"], code, re.MULTILINE)
        for m in matches:
            line_num = code[:m.start()].count("\n") + 1
            # Find context
            context_start = max(0, line_num - 2)
            context_end = min(len(lines), line_num + 2)
            context = "\n".join(lines[context_start:context_end])

            vulnerabilities.append({
                "type": vp["type"],
                "severity": vp["severity"],
                "line": line_num,
                "description": vp["description"],
                "suggestion": vp["suggestion"],
                "code": context.strip()
            })

    return vulnerabilities


def compute_gas_issues(code: str) -> List[dict]:
    """Analyze gas consumption issues (deterministic, based on code structure)"""
    _, _, gas_issues = analyze_gas(code)
    return gas_issues


def compute_security_score(vulnerabilities: List[dict]) -> int:
    """Compute overall security score"""
    if not vulnerabilities:
        return 100
    severity_weights = {"critical": 25, "high": 15, "medium": 8, "low": 3}
    deduction = sum(severity_weights.get(v["severity"], 5) for v in vulnerabilities)
    return max(0, 100 - deduction)


@app.get("/")
async def root():
    return {"message": "Smart Contract Security Auditor", "version": "1.0.0"}


@app.get("/api/patterns")
async def list_patterns():
    return {"code": 0, "message": "success", "data": VULNERABILITY_PATTERNS}


@app.post("/api/audit")
async def audit_contract(request: AuditRequest):
    vulnerabilities = detect_vulnerabilities(request.code)
    measurements, no_data, gas_issues = analyze_gas(request.code)
    valid_config, rejected = validate_budget_config(
        request.gasBudget.model_dump() if hasattr(request.gasBudget, "model_dump") else request.gasBudget)
    budget = evaluate_budget(measurements, no_data, valid_config)
    budget["rejected"] = rejected
    score = compute_security_score(vulnerabilities)

    result = {
        "id": str(uuid.uuid4()),
        "filename": request.filename,
        "score": score,
        "vulnerabilities": vulnerabilities,
        "gasIssues": gas_issues,
        "gasMeasurements": measurements,
        "gasNoData": no_data,
        "gasBudget": budget,
        "timestamp": datetime.now().isoformat()
    }

    return {"code": 0, "message": "success", "data": result}


@app.post("/api/gas/evaluate")
async def evaluate_gas_budget(request: GasEvaluateRequest):
    """用既有测量数据 + 新阈值配置重新评估，不重新采集消耗数据。"""
    valid_config, rejected = validate_budget_config(request.config)
    budget = evaluate_budget(request.measurements, request.noData, valid_config)
    budget["rejected"] = rejected
    return {"code": 0, "message": "success", "data": budget}


@app.get("/api/gas/rules")
async def gas_rules():
    return {"code": 0, "message": "success",
            "data": {"description": BUDGET_RULE_DESCRIPTION, **GAS_RULES}}


@app.get("/api/history")
async def get_history():
    return {"code": 0, "message": "success", "data": []}


@app.post("/api/report/{audit_id}")
async def generate_report(audit_id: str):
    """Generate PDF report"""
    # Simplified report generation
    return {"code": 0, "message": "success", "data": {"url": f"/api/reports/{audit_id}.pdf"}}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
