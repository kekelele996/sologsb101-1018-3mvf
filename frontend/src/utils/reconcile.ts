/**
 * 对账工具：把胎体与委托单按编号对账，给出每台胎体的对账状态。
 * - ok：已关联且编号对得上
 * - suspended：有委托单号但在委托单中对不上（挂起，等人判）
 * - unlinked：缺委托单号（待按委托人回填）
 * - returned：委托撤单后未开工已退回
 */
import type { Body } from '@/types/body';
import type { Order } from '@/types/order';

export type ReconcileStatus = 'ok' | 'suspended' | 'unlinked' | 'returned';

export interface ReconcileView {
  body: Body;
  status: ReconcileStatus;
  reason: string;
  order: Order | null;
}

/** 全量对账：逐台胎体匹配委托单，派生出对账状态（不写库） */
export function reconcileBodies(bodies: Body[], orders: Order[]): ReconcileView[] {
  return bodies.map((body) => {
    const order = body.orderId ? (orders.find((item) => item.id === body.orderId) ?? null) : null;
    if (body.returned) {
      return { body, status: 'returned', reason: '委托撤单，未开工已退回', order };
    }
    if (body.suspended) {
      return { body, status: 'suspended', reason: body.suspendedReason || '对账不匹配，待人工判定', order };
    }
    if (!body.orderNo) {
      return { body, status: 'unlinked', reason: '缺委托单号，待按委托人回填', order: null };
    }
    if (!order) {
      return { body, status: 'suspended', reason: `委托单号 ${body.orderNo} 在委托单中不存在，需人工判定`, order: null };
    }
    if (order.orderNo !== body.orderNo) {
      return { body, status: 'suspended', reason: `胎体填 ${body.orderNo}，委托单为 ${order.orderNo}，编号不一致`, order };
    }
    return { body, status: 'ok', reason: '', order };
  });
}

/** 胎体是否按旧版委托施工（已开工件照旧做完，依据版本落后于当前版本） */
export function isOldVersion(body: Body, order: Order | null): boolean {
  if (!order) return false;
  return body.basedOnVersion < order.version;
}

/** 胎体对账状态文案与配色 */
export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  ok: '已对账',
  suspended: '挂起',
  unlinked: '待回填',
  returned: '已退回',
};

export const RECONCILE_STATUS_COLOR: Record<ReconcileStatus, string> = {
  ok: '#2f6f4f',
  suspended: '#b03a2e',
  unlinked: '#c9963c',
  returned: '#8c8c8c',
};
