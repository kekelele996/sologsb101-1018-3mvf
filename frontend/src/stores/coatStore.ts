/**
 * 髹涂道次状态管理（Zustand）
 * 维护道次顺序与状态推进，支持拖拽重排落库重编号、批量改漆种与状态。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState } from '@/types/coat';
import { suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { resolveSpecBasis, suggestSpecDryingHours, type SpecBasis } from '@/utils/commissionSpec';
import { useBodyStore } from './bodyStore';
import { useCommissionStore } from './commissionStore';

export interface PaintSuggestion {
  paintType: PaintType;
  intervalHours: number;
  sourceCode: string;
  sourceColor: string;
  /** 湿膜厚度建议（按当前认到的委托版本算；改版后随之重算） */
  thicknessUm: number;
  /** 建议荫干时长（小时，标准荫房 24℃/75%） */
  dryingHours: number;
  /** 建议依据的委托版本号；无单为 null */
  basisRevision: number | null;
  /** 委托最新版本号；大于 basisRevision 时提示已改版 */
  latestRevision: number | null;
}

interface CoatStoreState {
  coats: Coat[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadCoats: () => Promise<void>;
  coatsOfBody: (bodyId: string) => Coat[];
  createCoat: (draft: CoatDraft) => Promise<Coat>;
  updateCoat: (id: string, patch: Partial<Coat>) => Promise<void>;
  removeCoat: (id: string) => Promise<void>;
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<void>;
  advanceState: (id: string) => Promise<void>;
  markRecheck: (bodyId: string, recheck: boolean) => Promise<void>;
  reorderCoats: (bodyId: string, orderedIds: string[]) => Promise<void>;
  /** 重排后重新启用一条被退回的道次：清退回标记并改挂到最新委托版本 */
  restoreReturned: (id: string, patch?: Partial<Coat>) => Promise<void>;
  nextSeq: (bodyId: string) => number;
  /** 同器型自动带出上次漆种与间隔建议；湿膜 / 荫干建议按认到的委托版本算 */
  suggestForBody: (bodyId: string) => PaintSuggestion;
  /** 取胎体当前规格依据（道次页 / 荫房页展示改版重算结果） */
  specBasisOfBody: (bodyId: string) => SpecBasis | null;
}

export const useCoatStore = create<CoatStoreState>((set, get) => ({
  coats: [],
  loading: false,
  ready: false,
  error: '',

  async loadCoats() {
    set({ loading: true });
    try {
      const coats = await db.coats.toArray();
      coats.sort((a, b) => (a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId)));
      set({ coats, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '道次读取失败' });
    }
  },

  coatsOfBody(bodyId) {
    return get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq);
  },

  async createCoat(draft) {
    const now = Date.now();
    // 依据版本：新道次一律按委托最新版（改版即按新版施工）；
    // 「照旧做完」只体现在已落道次上，不影响后续新道次。
    let basisRevision = draft.basisRevision;
    if (basisRevision === undefined || basisRevision === null) {
      const body = useBodyStore.getState().bodies.find((item) => item.id === draft.bodyId);
      if (body?.commissionId) {
        const commission = useCommissionStore.getState().commissionById(body.commissionId);
        basisRevision = commission
          ? Math.max(...commission.revisions.map((revision) => revision.revisionNo))
          : body.specRevision;
      } else {
        basisRevision = body?.specRevision ?? null;
      }
    }
    const row: Coat = { ...draft, basisRevision, returned: draft.returned ?? false, id: createId('coat'), createdAt: now, updatedAt: now };
    await db.coats.put(row);
    await get().loadCoats();
    return row;
  },

  async updateCoat(id, patch) {
    await db.coats.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadCoats();
  },

  async removeCoat(id) {
    const target = get().coats.find((coat) => coat.id === id);
    await db.coats.delete(id);
    if (target) {
      // 删除后按序重编号，保持 seq 连续
      const rest = get()
        .coats.filter((coat) => coat.bodyId === target.bodyId && coat.id !== id)
        .sort((a, b) => a.seq - b.seq)
        .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
      if (rest.length > 0) await db.coats.bulkPut(rest);
    }
    await get().loadCoats();
  },

  async batchUpdate(ids, patch) {
    if (ids.length === 0) return;
    const now = Date.now();
    const rows = get()
      .coats.filter((coat) => ids.includes(coat.id))
      .map((coat) => ({ ...coat, ...patch, updatedAt: now }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  async advanceState(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return;
    const next = nextCoatState(coat.state);
    if (next === coat.state) return;
    await get().updateCoat(id, { state: next });
  },

  async markRecheck(bodyId, recheck) {
    const affected = get().coats.filter((coat) => coat.bodyId === bodyId && coat.state !== 'done');
    if (affected.length === 0) return;
    const now = Date.now();
    await db.coats.bulkPut(affected.map((coat) => ({ ...coat, needRecheck: recheck, updatedAt: now })));
    await get().loadCoats();
  },

  async reorderCoats(bodyId, orderedIds) {
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const rows = get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  nextSeq(bodyId) {
    const list = get().coats.filter((coat) => coat.bodyId === bodyId);
    return list.length === 0 ? 1 : Math.max(...list.map((coat) => coat.seq)) + 1;
  },

  async restoreReturned(id, patch = {}) {
    const target = get().coats.find((coat) => coat.id === id);
    if (!target) return;
    const body = useBodyStore.getState().bodies.find((item) => item.id === target.bodyId);
    await db.coats.put({
      ...target,
      ...patch,
      returned: false,
      basisRevision: body?.specRevision ?? target.basisRevision,
      updatedAt: Date.now(),
    });
    await get().loadCoats();
  },

  specBasisOfBody(bodyId) {
    const body = useBodyStore.getState().bodies.find((item) => item.id === bodyId);
    if (!body) return null;
    const commission = body.commissionId
      ? useCommissionStore.getState().commissionById(body.commissionId) ?? null
      : null;
    return resolveSpecBasis(commission, {
      shape: body.shape,
      sizeMm: body.sizeMm,
      specRevision: body.specRevision,
    });
  },

  suggestForBody(bodyId) {
    const bodies = useBodyStore.getState().bodies;
    const current = bodies.find((body) => body.id === bodyId);
    const previousBody = bodies.find((body) => body.id !== bodyId && current !== undefined && body.shape === current.shape);
    const previousCoat = previousBody
      ? get()
          .coats.filter((coat) => coat.bodyId === previousBody.id)
          .sort((a, b) => a.seq - b.seq)
          .pop()
      : undefined;
    const paintType = suggestPaintType(get().nextSeq(bodyId), previousCoat?.paintType, current?.shape);
    const commission = current?.commissionId
      ? useCommissionStore.getState().commissionById(current.commissionId) ?? null
      : null;
    const latestNo = commission ? Math.max(...commission.revisions.map((revision) => revision.revisionNo)) : null;
    // 湿膜 / 荫干建议只认委托最新版：改版即作废重算，与已开工件照旧 / 重排口径无关
    const latestBasis = resolveSpecBasis(commission, {
      shape: current?.shape ?? 'bowl',
      sizeMm: current?.sizeMm ?? 120,
      specRevision: latestNo,
    });
    return {
      paintType,
      intervalHours: suggestIntervalHours(paintType),
      sourceCode: previousBody?.code ?? '',
      sourceColor: previousCoat?.colorName ?? '',
      thicknessUm: latestBasis.thicknessUm,
      dryingHours: suggestSpecDryingHours(latestBasis),
      basisRevision: latestBasis.revisionNo,
      latestRevision: latestNo,
    };
  },
}));

/** 道次派生选择器：按状态集合过滤 */
export function selectCoatsByStates(coats: Coat[], states: CoatState[]): Coat[] {
  if (states.length === 0) return coats;
  return coats.filter((coat) => states.includes(coat.state));
}
