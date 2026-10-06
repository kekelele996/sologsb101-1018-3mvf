/**
 * 委托单（Order）数据模型 —— 接单前台留底
 * 前台记委托人、器型、尺寸、交期；工序台凭委托单号与胎体对账。
 * 委托人中途改尺寸器型时累加版本，已开工件「照旧做完」并注明依据版本。
 */
import type { BodyShape } from '@/types/body';

/** 委托单状态：进行中 / 已撤单 / 已完成 */
export type OrderStatus = 'active' | 'cancelled' | 'done';

/** 委托版本：每次改尺寸或器型累加一版，留存改后规格与时间 */
export interface OrderVersion {
  /** 版本号，从 1 开始 */
  version: number;
  /** 该版本器型 */
  shape: BodyShape;
  /** 该版本尺寸（mm） */
  sizeMm: number;
  /** 变更时间戳 */
  changedAt: number;
  /** 变更说明，如「委托人改器型为瓶，尺寸加大」 */
  changeNote: string;
}

export interface Order {
  id: string;
  /** 委托单号（对外编号，对账依据），如 WT-2401 */
  orderNo: string;
  /** 委托人 */
  ownerName: string;
  /** 当前器型 */
  shape: BodyShape;
  /** 当前尺寸（mm） */
  sizeMm: number;
  /** 交期 yyyy-MM-dd */
  dueDate: string;
  /** 委托状态 */
  status: OrderStatus;
  /** 当前委托版本号（从 1 开始，改一次 +1） */
  version: number;
  /** 历史版本（含首版，按 version 升序） */
  versions: OrderVersion[];
  /** 撤单时间戳，未撤单为 null */
  cancelledAt: number | null;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type OrderDraft = Pick<Order, 'orderNo' | 'ownerName' | 'shape' | 'sizeMm' | 'dueDate' | 'note'>;

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  active: '进行中',
  cancelled: '已撤单',
  done: '已完成',
};

export const ORDER_STATUS_COLOR: Record<OrderStatus, string> = {
  active: '#3a6ea5',
  cancelled: '#8c8c8c',
  done: '#2f6f4f',
};

export const ORDER_STATUS_OPTIONS: ReadonlyArray<{ value: OrderStatus; label: string }> = [
  { value: 'active', label: '进行中' },
  { value: 'cancelled', label: '已撤单' },
  { value: 'done', label: '已完成' },
];

export function createEmptyOrderDraft(): OrderDraft {
  return {
    orderNo: '',
    ownerName: '',
    shape: 'bowl',
    sizeMm: 120,
    dueDate: '',
    note: '',
  };
}

/** 依据当前委托单生成下一版规格（不改原对象） */
export function nextOrderVersion(
  order: Order,
  shape: BodyShape,
  sizeMm: number,
  changeNote: string,
  now: number,
): OrderVersion {
  return { version: order.version + 1, shape, sizeMm, changedAt: now, changeNote };
}

/** 取委托单某一版规格，缺省回退到当前规格 */
export function orderSpecAt(order: Order, version: number): { shape: BodyShape; sizeMm: number } {
  const found = order.versions.find((item) => item.version === version);
  if (found) return { shape: found.shape, sizeMm: found.sizeMm };
  return { shape: order.shape, sizeMm: order.sizeMm };
}
