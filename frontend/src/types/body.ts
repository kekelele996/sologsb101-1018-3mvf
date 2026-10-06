/**
 * 胎体（Body）数据模型
 * 一件漆器的胎骨档案：材质、器型、主要尺寸与当前工序状态。
 */

import type { ChangePolicy } from '@/types/commission';

/** 胎体材质：木胎 / 脱胎 / 金属胎 */
export type BodyMaterial = 'wood' | 'lacquered' | 'metal';

/** 器型：碗 / 盘 / 盒 / 瓶 */
export type BodyShape = 'bowl' | 'plate' | 'box' | 'vase';

/** 胎体状态：待髹涂 / 髹涂中 / 待荫干 / 已完成 */
export type BodyState = 'pending' | 'coating' | 'drying' | 'done';

/**
 * 对账状态：胎体与委托单按编号核对后的处置。
 * - linked：已认一张在制委托单，规格一致
 * - held：两边对不上号（有号无单 / 单号被撤 / 规格不符），先挂起等人判
 * - unlinked：无委托单号（旧数据回填不出来的胎体单列于此）
 */
export type ReconStatus = 'linked' | 'held' | 'unlinked';

export interface Body {
  /** 主键，播种数据使用固定字符串便于深链命中 */
  id: string;
  /** 工作室内部编号 */
  code: string;
  /** 胎体材质 */
  material: BodyMaterial;
  /** 器型 */
  shape: BodyShape;
  /** 主要尺寸（毫米，取最大径） */
  sizeMm: number;
  /** 委托人或藏家 */
  ownerName: string;
  /** 当前状态 */
  state: BodyState;
  /**
   * 认到的委托单 id；null 表示无单胎体（工序台自产 / 旧数据回填不出）。
   * 每件胎体至多认一张委托单。
   */
  commissionId: string | null;
  /** 对账状态：认单一致 / 挂起待判 / 无单单列 */
  reconStatus: ReconStatus;
  /** 对账挂起原因（reconStatus === 'held' 时展示） */
  reconNote: string;
  /**
   * 当前认到的委托版本号（Commission.revisionNo）；
   * 委托改版后湿膜 / 荫干建议按此版本重算，null 表示无单。
   */
  specRevision: number | null;
  /**
   * 委托人改版时对这件已开工胎体选定的处置口径；
   * 未开工件无此概念（始终按新版重算），故允许 null。
   */
  specPolicy: ChangePolicy | null;
  /**
   * 退回标记：撤单（未开工）或改版选择「退回重排」后，
   * 胎体退出当前排产；已髹涂的件撤单时不退、不置此标记。
   */
  returned: boolean;
  createdAt: number;
  updatedAt: number;
}

export type BodyDraft = Omit<Body, 'id' | 'createdAt' | 'updatedAt'>;

export const BODY_MATERIAL_LABEL: Record<BodyMaterial, string> = {
  wood: '木胎',
  lacquered: '脱胎',
  metal: '金属胎',
};

export const BODY_SHAPE_LABEL: Record<BodyShape, string> = {
  bowl: '碗',
  plate: '盘',
  box: '盒',
  vase: '瓶',
};

export const BODY_STATE_LABEL: Record<BodyState, string> = {
  pending: '待髹涂',
  coating: '髹涂中',
  drying: '待荫干',
  done: '已完成',
};

export const BODY_STATE_COLOR: Record<BodyState, string> = {
  pending: '#8c8c8c',
  coating: '#c9963c',
  drying: '#3a6ea5',
  done: '#2f6f4f',
};

export const RECON_STATUS_LABEL: Record<ReconStatus, string> = {
  linked: '已认单',
  held: '挂起待判',
  unlinked: '无单单列',
};

export const RECON_STATUS_COLOR: Record<ReconStatus, string> = {
  linked: '#2f6f4f',
  held: '#b03a2e',
  unlinked: '#8c8479',
};

/** 状态推进链路，供「推进状态」按钮使用 */
export const BODY_STATE_FLOW: readonly BodyState[] = ['pending', 'coating', 'drying', 'done'];

export const BODY_MATERIAL_OPTIONS: ReadonlyArray<{ value: BodyMaterial; label: string }> = [
  { value: 'wood', label: '木胎' },
  { value: 'lacquered', label: '脱胎' },
  { value: 'metal', label: '金属胎' },
];

export const BODY_SHAPE_OPTIONS: ReadonlyArray<{ value: BodyShape; label: string }> = [
  { value: 'bowl', label: '碗' },
  { value: 'plate', label: '盘' },
  { value: 'box', label: '盒' },
  { value: 'vase', label: '瓶' },
];

export const BODY_STATE_OPTIONS: ReadonlyArray<{ value: BodyState; label: string }> =
  BODY_STATE_FLOW.map((state) => ({ value: state, label: BODY_STATE_LABEL[state] }));

/** 下一个状态；已是终态时返回原状态 */
export function nextBodyState(state: BodyState): BodyState {
  const index = BODY_STATE_FLOW.indexOf(state);
  if (index < 0 || index >= BODY_STATE_FLOW.length - 1) return state;
  return BODY_STATE_FLOW[index + 1] as BodyState;
}

export function createEmptyBodyDraft(): BodyDraft {
  return {
    code: '',
    material: 'wood',
    shape: 'bowl',
    sizeMm: 120,
    ownerName: '',
    state: 'pending',
    commissionId: null,
    reconStatus: 'unlinked',
    reconNote: '',
    specRevision: null,
    specPolicy: null,
    returned: false,
  };
}

/** 胎体维度的汇总统计，卡片回显使用 */
export interface BodyStat {
  bodyId: string;
  /** 已编排道次总数 */
  coatTotal: number;
  /** 已完成道次 */
  coatDone: number;
  /** 道次完成率 0-100 */
  coatPercent: number;
  /** 当前道次序号（无则 0） */
  currentSeq: number;
  /** 荫房记录条数 */
  roomCount: number;
  /** 荫房超标次数 */
  roomOverCount: number;
  /** 最近一次荫房判定文案 */
  lastRoomVerdict: string;
  /** 打磨道次条数 */
  polishCount: number;
  /** 镶嵌登记条数 */
  inlayCount: number;
  /** 累计荫干等待小时数 */
  dryingHours: number;
}
