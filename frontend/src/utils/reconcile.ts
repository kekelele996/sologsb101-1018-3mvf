/**
 * 前台委托单 ↔ 工序台胎体 对账逻辑
 * 每件胎体认一张委托单，两边按编号核对：
 * 对不上的胎体一律先挂起（held）等人判；旧数据缺单号且回填不出的单列（unlinked）。
 */
import type { Body } from '@/types/body';
import type { Commission } from '@/types/commission';
import { revisionAt } from '@/types/commission';

/** 挂起原因（在对账页分组展示） */
export type HeldReason =
  | 'missing' // 胎体有委托 id，但前台查无此单（单号写错 / 委托被物理删除）
  | 'duplicate' // 同一张委托单被多件胎体认领
  | 'cancelled' // 认到的是已撤委托
  | 'mismatch' // 单号对得上，但器型 / 尺寸与所依据版本不符
  | 'staleRevision'; // 委托已改版，等待管理员对这件定处置口径

export interface HeldItem {
  body: Body;
  commission: Commission | null;
  reason: HeldReason;
  detail: string;
}

export interface ReconcileResult {
  /** 认单且规格一致（含照旧做旧版） */
  linked: Body[];
  /** 对不上号、挂起等人工判定的胎体 */
  held: HeldItem[];
  /** 无委托单号、回填不出的胎体（单列） */
  unlinked: Body[];
  /** 前台有单、工序台还没开胎的委托 */
  unbound: Commission[];
  /** 委托已撤但已髹涂、按规矩留存的胎体 */
  retained: Body[];
}

export const HELD_REASON_LABEL: Record<HeldReason, string> = {
  missing: '有号无单',
  duplicate: '一单多认',
  cancelled: '委托已撤',
  mismatch: '规格不符',
  staleRevision: '已改版待定',
};

/** 判断胎体是否已开工：胎体非待髹涂，或存在已涂起的道次（由调用方传道次状态） */
export function isBodyStarted(body: Body, coats: Array<{ state: string }>): boolean {
  if (body.state !== 'pending') return true;
  return coats.some((coat) => coat.state !== 'todo');
}

function compareSpec(body: Body, commission: Commission): { ok: boolean; detail: string; stale: boolean } {
  const revisionNo = body.specRevision ?? 1;
  const revision = revisionAt(commission, revisionNo);
  if (!revision) {
    return { ok: false, stale: true, detail: `胎体依据第 ${revisionNo} 版，委托单中无此版本` };
  }
  if (revision.shape !== body.shape || revision.sizeMm !== body.sizeMm) {
    return {
      ok: false,
      stale: false,
      detail: `胎体记 ${body.shape}/${body.sizeMm}mm，委托第 ${revisionNo} 版为 ${revision.shape}/${revision.sizeMm}mm`,
    };
  }
  const latestNo = Math.max(...commission.revisions.map((item) => item.revisionNo));
  if (revisionNo < latestNo && body.specPolicy === null) {
    return { ok: false, stale: true, detail: `委托已出到第 ${latestNo} 版，本件仍按第 ${revisionNo} 版，待选处置口径` };
  }
  return { ok: true, detail: '', stale: false };
}

/**
 * 全量对账。纯函数：只返回分类结果，不落库；
 * 调用方（commissionStore）据此把胎体 reconStatus 持久化。
 */
export function reconcile(bodies: Body[], commissions: Commission[]): ReconcileResult {
  const commissionById = new Map(commissions.map((commission) => [commission.id, commission]));
  // 「一单多认」只统计未退回的胎体（退回件已退出在制，不算重复认领）
  const claimCounts = new Map<string, number>();
  bodies.forEach((body) => {
    if (body.commissionId && !body.returned) {
      claimCounts.set(body.commissionId, (claimCounts.get(body.commissionId) ?? 0) + 1);
    }
  });

  const linked: Body[] = [];
  const held: HeldItem[] = [];
  const unlinked: Body[] = [];
  const retained: Body[] = [];

  bodies.forEach((body) => {
    if (body.returned) return; // 退回的件不参加在制对账
    if (!body.commissionId) {
      unlinked.push(body);
      return;
    }
    const commission = commissionById.get(body.commissionId) ?? null;
    if (!commission) {
      held.push({ body, commission: null, reason: 'missing', detail: '胎体认的委托单号在前台台账中查不到' });
      return;
    }
    if ((claimCounts.get(body.commissionId) ?? 0) > 1) {
      held.push({ body, commission, reason: 'duplicate', detail: '同一张委托单被多件胎体认领，每件只能认一张单' });
      return;
    }
    if (commission.status === 'cancelled') {
      // 撤单：未开工件已在撤单动作里退回（returned），这里剩下的都是已髹涂留存件
      retained.push(body);
      return;
    }
    const spec = compareSpec(body, commission);
    if (!spec.ok) {
      held.push({
        body,
        commission,
        reason: spec.stale ? 'staleRevision' : 'mismatch',
        detail: spec.detail,
      });
      return;
    }
    linked.push(body);
  });

  const boundIds = new Set(bodies.filter((body) => !body.returned).map((body) => body.commissionId));
  const unbound = commissions.filter(
    (commission) => commission.status === 'active' && !boundIds.has(commission.id),
  );

  return { linked, held, unlinked, unbound, retained };
}

/** 单胎体即时判定（绑定 / 改单后用，避免全量扫描） */
export function classifyBody(body: Body, commission: Commission | null | undefined): ReconClassify {
  if (!body.commissionId || !commission) {
    return body.commissionId
      ? { status: 'held', note: '胎体认的委托单号在前台台账中查不到' }
      : { status: 'unlinked', note: '' };
  }
  if (commission.status === 'cancelled') {
    return { status: 'linked', note: '' };
  }
  const spec = compareSpec(body, commission);
  if (!spec.ok) return { status: 'held', note: spec.detail };
  return { status: 'linked', note: '' };
}

export interface ReconClassify {
  status: Body['reconStatus'];
  note: string;
}
