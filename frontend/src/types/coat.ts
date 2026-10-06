/**
 * 髹涂道次（Coat）数据模型
 * 一件胎体上的逐道髹涂记录：漆种、色名、涂刷日期、湿膜厚度与状态推进。
 */

/** 漆种：生漆 / 色漆 / 罩漆 */
export type PaintType = 'raw' | 'color' | 'topcoat';

/** 道次状态：待涂 / 已涂 / 待打磨 / 已完成 */
export type CoatState = 'todo' | 'coated' | 'toPolish' | 'done';

export interface Coat {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 道次序号，从 1 开始连续整数 */
  seq: number;
  /** 漆种 */
  paintType: PaintType;
  /** 色名，如「朱红」「漆黑」 */
  colorName: string;
  /** 涂刷日期 yyyy-MM-dd */
  coatDate: string;
  /** 湿膜厚度（微米） */
  thicknessUm: number;
  /** 当前状态 */
  state: CoatState;
  /** 荫房判定异常时回写的「待复检」标记 */
  needRecheck: boolean;
  /**
   * 本道施工所依据的委托版本号（Commission.revisionNo）。
   * 委托人改版后：已落的道次保留旧值，道次页据此写明「依据第 n 版」；
   * 新开的道次取委托最新版。无单胎体为 null。
   */
  basisRevision: number | null;
  /**
   * 退回标记：胎体认的委托改版且选择「退回重排」时，
   * 所有未涂（state === 'todo'）道次置为退回；已涂道次保留。
   * 撤单同理（未开工退回，已髹涂留存）。
   */
  returned: boolean;
  createdAt: number;
  updatedAt: number;
}

export type CoatDraft = Omit<Coat, 'id' | 'createdAt' | 'updatedAt'>;

export const PAINT_TYPE_LABEL: Record<PaintType, string> = {
  raw: '生漆',
  color: '色漆',
  topcoat: '罩漆',
};

export const COAT_STATE_LABEL: Record<CoatState, string> = {
  todo: '待涂',
  coated: '已涂',
  toPolish: '待打磨',
  done: '已完成',
};

export const COAT_STATE_COLOR: Record<CoatState, string> = {
  todo: '#8c8c8c',
  coated: '#c9963c',
  toPolish: '#8c2f1f',
  done: '#2f6f4f',
};

export const COAT_STATE_FLOW: readonly CoatState[] = ['todo', 'coated', 'toPolish', 'done'];

export const PAINT_TYPE_OPTIONS: ReadonlyArray<{ value: PaintType; label: string }> = [
  { value: 'raw', label: '生漆' },
  { value: 'color', label: '色漆' },
  { value: 'topcoat', label: '罩漆' },
];

export const COAT_STATE_OPTIONS: ReadonlyArray<{ value: CoatState; label: string }> =
  COAT_STATE_FLOW.map((state) => ({ value: state, label: COAT_STATE_LABEL[state] }));

/** 色名候选，表单下拉直接复用 */
export const COLOR_NAME_OPTIONS: readonly string[] = [
  '漆黑',
  '朱红',
  '赭石',
  '藤黄',
  '石绿',
  '推光本色',
  '描金',
];

export function nextCoatState(state: CoatState): CoatState {
  const index = COAT_STATE_FLOW.indexOf(state);
  if (index < 0 || index >= COAT_STATE_FLOW.length - 1) return state;
  return COAT_STATE_FLOW[index + 1] as CoatState;
}

export function createEmptyCoatDraft(bodyId: string, seq: number): CoatDraft {
  return {
    bodyId,
    seq,
    paintType: 'raw',
    colorName: '漆黑',
    coatDate: new Date().toISOString().slice(0, 10),
    thicknessUm: 40,
    state: 'todo',
    needRecheck: false,
    basisRevision: null,
    returned: false,
  };
}
