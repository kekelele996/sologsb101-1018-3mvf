/**
 * 委托单（Commission）数据模型 —— 前台接单台账
 * 与工序台的胎体（Body）各记各的：前台只留委托人、器型、尺寸、交期，
 * 胎体通过 commissionId 认一张委托单，两边按编号对账。
 *
 * 委托人中途改尺寸 / 器型时，不覆盖旧值，而是向 revisions 追加一个新版本：
 * 已开工道次的湿膜厚度建议与荫干时长按新版作废重算，旧道次仍写明依据哪一版。
 */
import type { BodyMaterial, BodyShape } from '@/types/body';

/** 委托单状态：在制 / 已撤单 / 已完成 */
export type CommissionStatus = 'active' | 'cancelled' | 'done';

/**
 * 委托单的一个版本。
 * revisionNo 从 1 开始连续递增；最新一版为当前有效规格。
 */
export interface CommissionRevision {
  /** 版本号，从 1 开始 */
  revisionNo: number;
  /** 该版器型 */
  shape: BodyShape;
  /** 该版主要尺寸（毫米，取最大径） */
  sizeMm: number;
  /** 该版备注，如「委托人要求改小碗」 */
  note: string;
  /** 版本生效时间（毫秒时间戳） */
  changedAt: number;
}

export interface Commission {
  id: string;
  /** 委托单号（前台编号，对账主键，唯一） */
  code: string;
  /** 委托人 */
  clientName: string;
  /** 联系方式（选填） */
  contact: string;
  /** 胎体材质要求，供开胎时带出 */
  material: BodyMaterial;
  /** 交期 yyyy-MM-dd */
  dueDate: string;
  /** 状态 */
  status: CommissionStatus;
  /** 版本历史，按 revisionNo 升序，至少含第 1 版 */
  revisions: CommissionRevision[];
  /** 撤单时间（毫秒时间戳），未撤为 null */
  cancelledAt: number | null;
  /** 撤单备注 */
  cancelNote: string;
  createdAt: number;
  updatedAt: number;
}

export type CommissionDraft = Pick<
  Commission,
  'code' | 'clientName' | 'contact' | 'material' | 'dueDate'
> & {
  shape: BodyShape;
  sizeMm: number;
  revisionNote?: string;
};

export const COMMISSION_STATUS_LABEL: Record<CommissionStatus, string> = {
  active: '在制',
  cancelled: '已撤单',
  done: '已完成',
};

export const COMMISSION_STATUS_COLOR: Record<CommissionStatus, string> = {
  active: '#2f6f4f',
  cancelled: '#8c8479',
  done: '#3a6ea5',
};

export const COMMISSION_STATUS_OPTIONS: ReadonlyArray<{ value: CommissionStatus; label: string }> = [
  { value: 'active', label: '在制' },
  { value: 'cancelled', label: '已撤单' },
  { value: 'done', label: '已完成' },
];

/**
 * 委托人改尺寸 / 器型后，已开工胎体的处置口径（由管理员在改版时逐件选定）：
 * - finishOld：已开工的件照旧做完，道次页写明依据哪版委托
 * - reschedule：退回重排，未涂道次标「退回」，按新版重新铺排
 */
export type ChangePolicy = 'finishOld' | 'reschedule';

export const CHANGE_POLICY_LABEL: Record<ChangePolicy, string> = {
  finishOld: '照旧做完（旧版道次保留，写明依据版本）',
  reschedule: '退回重排（未涂道次退回，按新版重排）',
};

export const CHANGE_POLICY_OPTIONS: ReadonlyArray<{ value: ChangePolicy; label: string }> = [
  { value: 'finishOld', label: CHANGE_POLICY_LABEL.finishOld },
  { value: 'reschedule', label: CHANGE_POLICY_LABEL.reschedule },
];

/** 最新一版规格（revisions 为空时理论上不会发生，做兜底） */
export function latestRevision(commission: Commission): CommissionRevision | undefined {
  return [...commission.revisions].sort((a, b) => a.revisionNo - b.revisionNo).pop();
}

/** 指定版本号对应的规格 */
export function revisionAt(commission: Commission, revisionNo: number): CommissionRevision | undefined {
  return commission.revisions.find((revision) => revision.revisionNo === revisionNo);
}

/** 下一可用版本号 */
export function nextRevisionNo(commission: Commission): number {
  return commission.revisions.reduce((max, revision) => Math.max(max, revision.revisionNo), 0) + 1;
}

export function createEmptyCommissionDraft(): CommissionDraft {
  return {
    code: '',
    clientName: '',
    contact: '',
    material: 'wood',
    dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    shape: 'bowl',
    sizeMm: 120,
    revisionNote: '',
  };
}

/** 交期剩余天数（负数为已逾期） */
export function daysUntilDue(dueDate: string, now: number = Date.now()): number {
  const due = new Date(`${dueDate}T00:00:00`).getTime();
  if (!Number.isFinite(due)) return Number.NaN;
  return Math.round((due - now) / 86400000);
}
