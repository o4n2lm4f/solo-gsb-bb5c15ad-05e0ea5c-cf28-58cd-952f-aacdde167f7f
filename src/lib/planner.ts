import {
  alignTo,
  blockSize,
  formatCidr,
  intToIp,
  parseCidr,
  prefixForHosts,
  type ParsedCidr,
} from './ip'
import type {
  Baseline,
  BaselineEntry,
  FailureItem,
  PlanOptions,
  PlanResult,
  PlannerInput,
  RearrangeInfo,
  RearrangeNote,
  RequirementInput,
  ReservedInput,
  Segment,
} from './types'

interface Interval {
  start: number
  end: number
}

interface Occupied extends Interval {
  kind: 'reserved' | 'fixed' | 'auto'
  name: string
  prefix: number
  network: number
  requestedHosts?: number
  ownerId?: string
}

interface Gap extends Interval {
  length: number
}

/** 计算已占用区间之外、按父网段边界裁剪后的全部空闲间隙（按地址升序） */
function computeGaps(parentStart: number, parentEnd: number, occupied: Interval[]): Gap[] {
  const sorted = [...occupied].sort((a, b) => a.start - b.start || a.end - b.end)
  const gaps: Gap[] = []
  let cursor = parentStart
  for (const iv of sorted) {
    if (iv.end < cursor) continue // 完全包含在已处理区间内
    const start = Math.max(cursor, iv.start)
    if (start > cursor) {
      gaps.push({ start: cursor, end: start - 1, length: start - cursor })
    }
    cursor = Math.max(cursor, iv.end + 1)
    if (cursor > parentEnd) break
  }
  if (cursor <= parentEnd) {
    gaps.push({ start: cursor, end: parentEnd, length: parentEnd - cursor + 1 })
  }
  return gaps
}

function usableOf(size: number): number {
  return size >= 4 ? size - 2 : 0
}

function describeRange(network: number, size: number, broadcast: number) {
  if (size < 4) {
    // /31、/32 无标准意义上的可用主机地址
    return { firstUsable: '—', lastUsable: '—', usable: 0 }
  }
  return {
    firstUsable: intToIp(network + 1),
    lastUsable: intToIp(broadcast - 1),
    usable: size - 2,
  }
}

function toSegment(oc: Occupied): Segment {
  const size = blockSize(oc.prefix)
  const broadcast = oc.prefix === 32 ? oc.network : oc.network + size - 1
  const { firstUsable, lastUsable, usable } = describeRange(oc.network, size, broadcast)
  const waste =
    oc.requestedHosts !== undefined ? Math.max(0, usable - oc.requestedHosts) : 0
  return {
    kind: oc.kind,
    name: oc.name,
    cidr: formatCidr(oc.network, oc.prefix),
    prefix: oc.prefix,
    network: intToIp(oc.network),
    broadcast: intToIp(broadcast),
    firstUsable,
    lastUsable,
    start: oc.network,
    end: broadcast,
    capacity: size,
    usable,
    waste,
    requestedHosts: oc.requestedHosts,
    ownerId: oc.ownerId,
  }
}

function freeSegment(gap: Gap): Segment {
  return {
    kind: 'free',
    name: '空闲',
    cidr: `${intToIp(gap.start)} – ${intToIp(gap.end)}`,
    prefix: -1,
    network: intToIp(gap.start),
    broadcast: intToIp(gap.end),
    firstUsable: '—',
    lastUsable: '—',
    start: gap.start,
    end: gap.end,
    capacity: gap.length,
    usable: gap.length,
    waste: 0,
  }
}

function overlap(a: Interval, b: Interval): boolean {
  return a.start <= b.end && b.start <= a.end
}

interface ParsedFixed {
  req: RequirementInput
  parsed: ParsedCidr
  hosts: number
}

/** 一条待分配的自动需求（index 为录入顺序） */
interface AutoEntry {
  req: RequirementInput
  hosts: number
  index: number
}

/** 既有最低对齐策略：在占用区之外按地址升序，取第一个能容纳该前缀对齐块的间隙起点 */
function lowestAlignedStart(
  parentStart: number,
  parentEnd: number,
  occupied: Interval[],
  prefix: number,
): number | null {
  const size = blockSize(prefix)
  const gaps = computeGaps(parentStart, parentEnd, occupied)
  for (const gap of gaps) {
    if (gap.length < size) continue
    // 间隙内第一个满足前缀边界对齐的地址（对齐结果若落在间隙之前则推进一个块）
    let alignedStart = alignTo(gap.start, prefix)
    if (alignedStart < gap.start) alignedStart += size
    if (alignedStart + size - 1 <= gap.end) {
      return alignedStart >>> 0 // 最低对齐空闲地址（间隙已按地址升序）
    }
  }
  return null
}

/** 分配失败原因：最大连续空闲块不足，或空闲块足够但没有满足边界对齐的空间 */
function gapFailureReason(
  parentStart: number,
  parentEnd: number,
  occupied: Interval[],
  prefix: number,
): string {
  const size = blockSize(prefix)
  const gapsNow = computeGaps(parentStart, parentEnd, occupied)
  const maxGap = gapsNow.reduce((m, g) => Math.max(m, g.length), 0)
  if (maxGap < size) {
    return `需要至少 ${size} 个连续地址（/${prefix}，可用 ${usableOf(size)} 台），当前最大连续空闲块仅 ${maxGap} 个地址`
  }
  return `空闲块虽有 ${maxGap} 个地址，但不存在满足 /${prefix} 边界对齐的 ${size} 地址空间`
}

/** 既有分配策略：自动需求从大到小（前缀小者优先），同规模按录入顺序，逐个取最低对齐空闲地址 */
function allocateLowestAligned(
  entries: AutoEntry[],
  parentStart: number,
  parentEnd: number,
  occupied: Occupied[],
  failures: FailureItem[],
): void {
  const ordered = [...entries].sort(
    (a, b) => prefixForHosts(a.hosts) - prefixForHosts(b.hosts) || a.index - b.index,
  )
  for (const { req, hosts } of ordered) {
    const prefix = prefixForHosts(hosts)
    const size = blockSize(prefix)
    const label = req.name || '未命名需求'

    if (size < hosts + 2) {
      failures.push({
        id: req.id,
        name: label,
        hosts,
        reason: `需要 ${hosts} 台主机，超过 IPv4 最大单网段可用容量 4294967294（/0）`,
      })
      continue
    }

    const start = lowestAlignedStart(parentStart, parentEnd, occupied, prefix)
    if (start === null) {
      failures.push({
        id: req.id,
        name: label,
        hosts,
        reason: gapFailureReason(parentStart, parentEnd, occupied, prefix),
      })
      continue
    }

    occupied.push({
      kind: 'auto',
      name: label,
      prefix,
      network: start,
      start,
      end: start + size - 1,
      requestedHosts: hosts,
      ownerId: req.id,
    })
  }
}

/** 基线自动需求的优先候选：按当前主机数计算目标前缀后，包含原网络地址的对齐块 */
interface BaselineCandidate {
  entry: AutoEntry
  baseline: BaselineEntry
  prefix: number
  size: number
  /** 候选块起始地址（包含原网络地址、按目标前缀对齐） */
  start: number
  end: number
}

/**
 * 基线优先重排：为每个基线自动需求按当前主机数计算目标前缀，
 * 把「包含原网络地址的对齐块」作为优先候选；候选越界、撞保留区/固定段或彼此冲突时，
 * 按所需地址数从大到小、同规模按录入顺序保留可行候选，
 * 落选候选与其余需求（新增、基线时未分配等）再按既有最低对齐策略分配。
 */
function allocateBaselineFirst(
  entries: AutoEntry[],
  baseline: Baseline,
  parentStart: number,
  parentEnd: number,
  occupied: Occupied[],
  failures: FailureItem[],
): RearrangeInfo {
  const baselineById = new Map(baseline.entries.map((e) => [e.id, e]))
  const candidates: BaselineCandidate[] = []
  const rest: AutoEntry[] = []
  for (const entry of entries) {
    const base = baselineById.get(entry.req.id)
    if (
      base &&
      base.state === 'allocated' &&
      base.kind === 'auto' &&
      base.start !== undefined &&
      base.prefix !== undefined
    ) {
      const prefix = prefixForHosts(entry.hosts)
      const size = blockSize(prefix)
      const start = alignTo(base.start, prefix)
      candidates.push({ entry, baseline: base, prefix, size, start, end: start + size - 1 })
    } else {
      rest.push(entry)
    }
  }

  // 保留可行候选：按所需地址数从大到小，同规模按录入顺序
  const dropReason = new Map<string, string>()
  const retainedIds = new Set<string>()
  const ordered = [...candidates].sort((a, b) => b.size - a.size || a.entry.index - b.entry.index)
  for (const cand of ordered) {
    const { req, hosts } = cand.entry
    const label = req.name || '未命名需求'
    const cidr = formatCidr(cand.start, cand.prefix)
    if (cand.size < hosts + 2) {
      dropReason.set(req.id, `需要 ${hosts} 台主机，超过 IPv4 最大单网段可用容量 4294967294（/0）`)
      continue
    }
    if (cand.start < parentStart || cand.end > parentEnd) {
      dropReason.set(req.id, `候选块 ${cidr} 越出父网段`)
      continue
    }
    const hit = occupied.find((oc) => overlap(oc, cand))
    if (hit) {
      const hitKind =
        hit.kind === 'reserved' ? '保留区' : hit.kind === 'fixed' ? '固定网段' : '已保留的候选'
      dropReason.set(req.id, `候选块 ${cidr} 与${hitKind}“${hit.name}”冲突`)
      continue
    }
    retainedIds.add(req.id)
    occupied.push({
      kind: 'auto',
      name: label,
      prefix: cand.prefix,
      network: cand.start,
      start: cand.start,
      end: cand.end,
      requestedHosts: hosts,
      ownerId: req.id,
    })
  }

  // 其余需求（落选候选 + 无基线候选的需求）按既有最低对齐策略分配
  const remaining = [
    ...candidates.filter((c) => !retainedIds.has(c.entry.req.id)).map((c) => c.entry),
    ...rest,
  ]
  allocateLowestAligned(remaining, parentStart, parentEnd, occupied, failures)

  // 汇总每个基线自动需求的重排结果（按录入顺序输出）
  const segByOwner = new Map<string, Occupied>()
  for (const oc of occupied) if (oc.ownerId) segByOwner.set(oc.ownerId, oc)
  const failureById = new Map(failures.map((f) => [f.id, f]))

  const notes: RearrangeNote[] = candidates.map((cand) => {
    const id = cand.entry.req.id
    const name = cand.entry.req.name || '未命名需求'
    const hosts = cand.entry.hosts
    const baseStart = cand.baseline.start!
    const basePrefix = cand.baseline.prefix!
    const baselineCidr = formatCidr(baseStart, basePrefix)
    const seg = segByOwner.get(id)
    if (seg && seg.network === baseStart) {
      // 网络地址未变 = 保留原址（前缀可能随主机数调整）
      return {
        id,
        name,
        hosts,
        baselineCidr,
        outcome: 'kept' as const,
        cidr: formatCidr(seg.network, seg.prefix),
        detail:
          seg.prefix === basePrefix
            ? `保留原址 ${formatCidr(seg.network, seg.prefix)}`
            : `保留原址 ${intToIp(seg.network)}，容量随主机数调整（/${basePrefix} → /${seg.prefix}）`,
      }
    }
    if (seg) {
      const cidr = formatCidr(seg.network, seg.prefix)
      const why = retainedIds.has(id)
        ? `扩容后包含原网络地址 ${intToIp(baseStart)} 的对齐块变为 ${cidr}`
        : `${dropReason.get(id) ?? '原址候选不可行'}，按最低对齐策略另选地址`
      return {
        id,
        name,
        hosts,
        baselineCidr,
        outcome: 'migrated' as const,
        cidr,
        detail: `${why}，迁至 ${cidr}`,
      }
    }
    const f = failureById.get(id)
    const parts = [dropReason.get(id), f?.reason].filter(Boolean)
    return {
      id,
      name,
      hosts,
      baselineCidr,
      outcome: 'unallocated' as const,
      detail: `无法分配：${parts.join('；')}`,
    }
  })

  return { notes }
}

export function plan(input: PlannerInput, options?: PlanOptions): PlanResult {
  const inputErrors: string[] = []
  const occupied: Occupied[] = []

  // 1) 解析并校验父网段
  const parentRaw = input.parentCidr.trim()
  if (!parentRaw) {
    inputErrors.push('请填写父 CIDR（例如 192.168.1.0/24）')
  }
  const parentParsed = parentRaw ? parseCidr(parentRaw, true) : null
  if (parentParsed && 'error' in parentParsed) {
    inputErrors.push(`父网段无效：${parentParsed.error}`)
  }
  const parent = parentParsed && !('error' in parentParsed) ? parentParsed : null
  const parentStart = parent ? parent.network : 0
  const parentEnd = parent ? parent.broadcast : 0
  const parentSize = parent ? parent.size : 0

  const withinParent = (s: number, e: number) =>
    parent !== null && s >= parentStart && e <= parentEnd

  // 2) 解析保留区
  const reservedItems: { item: ReservedInput; parsed: ParsedCidr }[] = []
  for (const r of input.reservations) {
    if (!r.cidr.trim() && !r.name.trim()) continue
    if (!r.cidr.trim()) {
      inputErrors.push(`保留区“${r.name || '未命名'}”缺少 CIDR`)
      continue
    }
    const parsed = parseCidr(r.cidr, true)
    if ('error' in parsed) {
      inputErrors.push(`保留区“${r.name || r.cidr}”无效：${parsed.error}`)
      continue
    }
    if (parent && !withinParent(parsed.network, parsed.broadcast)) {
      inputErrors.push(
        `保留区“${r.name || r.cidr}”（${formatCidr(parsed.network, parsed.prefix)}）不在父网段 ${parentRaw} 内`,
      )
      continue
    }
    reservedItems.push({ item: r, parsed })
  }

  // 3) 解析需求：固定网段 vs 自动网段
  const fixedItems: ParsedFixed[] = []
  const autoItems: { req: RequirementInput; hosts: number }[] = []
  for (const req of input.requirements) {
    if (req.name.trim() === '' && req.hosts === '' && req.cidr.trim() === '') continue
    const label = req.name || '未命名需求'
    if (req.hosts === '' || !Number.isInteger(req.hosts) || req.hosts <= 0) {
      inputErrors.push(`需求“${label}”的主机数无效（需为大于 0 的整数）`)
      continue
    }
    const hosts = req.hosts
    if (req.cidr.trim() !== '') {
      const parsed = parseCidr(req.cidr, true)
      if ('error' in parsed) {
        inputErrors.push(`需求“${label}”的固定网段无效：${parsed.error}`)
        continue
      }
      if (parent && !withinParent(parsed.network, parsed.broadcast)) {
        inputErrors.push(
          `需求“${label}”的固定网段 ${formatCidr(parsed.network, parsed.prefix)} 不在父网段 ${parentRaw} 内`,
        )
        continue
      }
      const usable = usableOf(parsed.size)
      if (usable < hosts) {
        inputErrors.push(
          `需求“${label}”需要 ${hosts} 台主机，但固定网段 ${formatCidr(parsed.network, parsed.prefix)} 仅提供 ${usable} 个可用地址（总容量 ${parsed.size}）`,
        )
        continue
      }
      fixedItems.push({ req, parsed, hosts })
    } else {
      autoItems.push({ req, hosts })
    }
  }

  // 4) 保留区与固定网段两两互不重叠（任一非法即终止，避免区间不可信）
  if (parent) {
    const claims: { label: string; iv: Interval }[] = [
      ...reservedItems.map(({ item, parsed }) => ({
        label: `保留区“${item.name || formatCidr(parsed.network, parsed.prefix)}”`,
        iv: { start: parsed.network, end: parsed.broadcast },
      })),
      ...fixedItems.map(({ req, parsed }) => ({
        label: `需求“${req.name || formatCidr(parsed.network, parsed.prefix)}”的固定网段`,
        iv: { start: parsed.network, end: parsed.broadcast },
      })),
    ]
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        if (overlap(claims[i].iv, claims[j].iv)) {
          inputErrors.push(`${claims[i].label}与${claims[j].label}地址重叠`)
        }
      }
    }
  }

  if (!parent || inputErrors.length > 0) {
    return {
      parentCidr: parentRaw,
      parentNetwork: parent ? intToIp(parent.network) : '',
      parentPrefix: parent ? parent.prefix : -1,
      parentSize,
      segments: [],
      failures: [],
      inputErrors,
      summary: emptySummary(parent),
    }
  }

  // 占用区：保留区 + 固定网段
  for (const { item, parsed } of reservedItems) {
    occupied.push({
      kind: 'reserved',
      name: item.name || formatCidr(parsed.network, parsed.prefix),
      prefix: parsed.prefix,
      network: parsed.network,
      start: parsed.network,
      end: parsed.broadcast,
      ownerId: item.id,
    })
  }
  for (const { req, parsed, hosts } of fixedItems) {
    occupied.push({
      kind: 'fixed',
      name: req.name || formatCidr(parsed.network, parsed.prefix),
      prefix: parsed.prefix,
      network: parsed.network,
      start: parsed.network,
      end: parsed.broadcast,
      requestedHosts: hosts,
      ownerId: req.id,
    })
  }

  // 5) 自动需求分配：基线优先重排仅在父网段与基线一致时生效，否则用既有最低对齐策略
  const failures: FailureItem[] = []
  const indexedAuto: AutoEntry[] = autoItems.map((entry, index) => ({ ...entry, index }))

  const baselineFirst =
    options?.baselineFirst &&
    options.baselineFirst.parentCidr === formatCidr(parent.network, parent.prefix)
      ? options.baselineFirst
      : null

  let rearrange: RearrangeInfo | undefined
  if (baselineFirst) {
    rearrange = allocateBaselineFirst(
      indexedAuto,
      baselineFirst,
      parentStart,
      parentEnd,
      occupied,
      failures,
    )
  } else {
    allocateLowestAligned(indexedAuto, parentStart, parentEnd, occupied, failures)
  }

  // 6) 生成最终网段序列（占用 + 空闲，按地址排序）
  const segments: Segment[] = []
  const occSegments = occupied.sort((a, b) => a.start - b.start).map(toSegment)
  const finalGaps = computeGaps(parentStart, parentEnd, occupied)
  let gi = 0
  for (const seg of occSegments) {
    while (gi < finalGaps.length && finalGaps[gi].end < seg.start) {
      segments.push(freeSegment(finalGaps[gi]))
      gi++
    }
    segments.push(seg)
  }
  while (gi < finalGaps.length) {
    segments.push(freeSegment(finalGaps[gi]))
    gi++
  }

  // 7) 统计
  const sumCapacity = (k: Segment['kind']) =>
    segments.filter((s) => s.kind === k).reduce((acc, s) => acc + s.capacity, 0)
  const reservedCap = sumCapacity('reserved')
  const fixedCap = sumCapacity('fixed')
  const autoCap = sumCapacity('auto')
  const freeCap = sumCapacity('free')
  const allocatedUsable = segments
    .filter((s) => s.kind === 'auto' || s.kind === 'fixed')
    .reduce((acc, s) => acc + s.usable, 0)
  const requestedHosts = segments
    .filter((s) => s.kind === 'auto' || s.kind === 'fixed')
    .reduce((acc, s) => acc + (s.requestedHosts ?? 0), 0)
  const waste = segments
    .filter((s) => s.kind === 'auto' || s.kind === 'fixed')
    .reduce((acc, s) => acc + s.waste, 0)

  return {
    parentCidr: formatCidr(parent.network, parent.prefix),
    parentNetwork: intToIp(parent.network),
    parentPrefix: parent.prefix,
    parentSize,
    segments,
    failures,
    inputErrors,
    ...(rearrange ? { rearrange } : {}),
    summary: {
      reserved: reservedCap,
      fixed: fixedCap,
      auto: autoCap,
      free: freeCap,
      totalCapacity: parentSize,
      usedCapacity: reservedCap + fixedCap + autoCap,
      allocatedUsable,
      requestedHosts,
      waste,
      utilization: parentSize === 0 ? 0 : ((reservedCap + fixedCap + autoCap) / parentSize) * 100,
    },
  }
}

function emptySummary(parent: ParsedCidr | null): PlanResult['summary'] {
  return {
    reserved: 0,
    fixed: 0,
    auto: 0,
    free: 0,
    totalCapacity: parent ? parent.size : 0,
    usedCapacity: 0,
    allocatedUsable: 0,
    requestedHosts: 0,
    waste: 0,
    utilization: 0,
  }
}
