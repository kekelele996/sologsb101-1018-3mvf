/**
 * 前台委托单状态管理（Zustand）
 * 接单前台与工序台各记各的：本 store 只读写 commissions 表，
 * 需要联动胎体 / 道次时走跨 store 调用；前台自身的写入失败只重试自己那份。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import { retryFrontDeskWrite } from '@/utils/retry';
import { reconcile, classifyBody } from '@/utils/reconcile';
import { isBodyStarted } from '@/utils/reconcile';
import type {
  ChangePolicy,
  Commission,
  CommissionDraft,
  CommissionStatus,
} from '@/types/commission';
import { nextRevisionNo } from '@/types/commission';
import type { Body, BodyShape } from '@/types/body';
import type { Coat } from '@/types/coat';
import { useBodyStore } from './bodyStore';
import { useCoatStore } from './coatStore';

export interface RevisionPayload {
  shape: BodyShape;
  sizeMm: number;
  note: string;
}

interface CommissionStoreState {
  commissions: Commission[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadCommissions: () => Promise<void>;
  commissionById: (id: string | null) => Commission | undefined;
  /** 前台登记委托单；写失败只重试 commissions 这一份 */
  createCommission: (draft: CommissionDraft) => Promise<Commission>;
  /** 改委托人 / 联系方式 / 交期（不产生新版本） */
  updateCommissionInfo: (id: string, patch: Partial<Pick<Commission, 'clientName' | 'contact' | 'dueDate' | 'material'>>) => Promise<void>;
  /** 改器型 / 尺寸：追加新版本，并对已认单的胎体按口径处置 */
  reviseCommission: (id: string, payload: RevisionPayload, policy: ChangePolicy) => Promise<void>;
  cancelCommission: (id: string, note: string) => Promise<void>;
  completeCommission: (id: string) => Promise<void>;
  removeCommission: (id: string) => Promise<void>;
  /** 胎体认单：每件胎体认一张委托单，认完立即重新对账 */
  bindBody: (bodyId: string, commissionId: string) => Promise<void>;
  /** 解绑（判为无单 / 认错过号）：胎体进无单单列 */
  unbindBody: (bodyId: string, note?: string) => Promise<void>;
  /** 人工判完，解除挂起：按当前单号与版本重新核对，核对一致才落 linked */
  resolveHeld: (bodyId: string, patch: { commissionId: string | null; specRevision?: number; note?: string }) => Promise<void>;
  /** 全量重算胎体 reconStatus 并持久化（初始化 / 跨页操作后调用） */
  recomputeReconcile: () => Promise<void>;
}

/** 该委托认到的、未退回的胎体 */
function boundBodies(commissionId: string): Body[] {
  return useBodyStore
    .getState()
    .bodies.filter((body) => body.commissionId === commissionId && !body.returned);
}

function coatsOf(bodyId: string): Coat[] {
  return useCoatStore.getState().coats.filter((coat) => coat.bodyId === bodyId);
}

export const useCommissionStore = create<CommissionStoreState>((set, get) => ({
  commissions: [],
  loading: false,
  ready: false,
  error: '',

  async loadCommissions() {
    set({ loading: true });
    try {
      const commissions = await db.commissions.orderBy('updatedAt').reverse().toArray();
      set({ commissions, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '委托单读取失败' });
    }
  },

  commissionById(id) {
    if (id === null) return undefined;
    return get().commissions.find((commission) => commission.id === id);
  },

  async createCommission(draft) {
    const now = Date.now();
    const row: Commission = {
      id: createId('comm'),
      code: draft.code,
      clientName: draft.clientName,
      contact: draft.contact,
      material: draft.material,
      dueDate: draft.dueDate,
      status: 'active',
      revisions: [
        { revisionNo: 1, shape: draft.shape, sizeMm: draft.sizeMm, note: draft.revisionNote || '初版委托', changedAt: now },
      ],
      cancelledAt: null,
      cancelNote: '',
      createdAt: now,
      updatedAt: now,
    };
    // 前台写入失败后只重试自己那份（commissions 表的 put），不触碰胎体 / 道次
    await retryFrontDeskWrite(() => db.commissions.put(row));
    await get().loadCommissions();
    return row;
  },

  async updateCommissionInfo(id, patch) {
    await db.commissions.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadCommissions();
  },

  async reviseCommission(id, payload, policy) {
    const commission = get().commissions.find((item) => item.id === id);
    if (!commission) return;
    const now = Date.now();
    const revisionNo = nextRevisionNo(commission);
    const next: Commission = {
      ...commission,
      revisions: [
        ...commission.revisions,
        { revisionNo, shape: payload.shape, sizeMm: payload.sizeMm, note: payload.note, changedAt: now },
      ],
      updatedAt: now,
    };

    const bodyStore = useBodyStore.getState();
    const coatStore = useCoatStore.getState();
    const targets = boundBodies(id);

    await db.transaction('rw', db.commissions, db.bodies, db.coats, async () => {
      await db.commissions.put(next);
      for (const body of targets) {
        const coats = coatsOf(body.id);
        const started = isBodyStarted(body, coats);
        if (!started) {
          // 未开工：湿膜 / 荫干建议直接按新版重算，胎体规格同步到新版
          await db.bodies.update(body.id, {
            shape: payload.shape,
            sizeMm: payload.sizeMm,
            specRevision: revisionNo,
            specPolicy: null,
            reconStatus: 'linked',
            reconNote: '',
            updatedAt: now,
          } as never);
          continue;
        }
        if (policy === 'finishOld') {
          // 照旧做完：胎体与已落道次保留旧版依据，仅登记口径；后续新道次按新版
          await db.bodies.update(body.id, {
            specPolicy: 'finishOld',
            specRevision: body.specRevision ?? revisionNo - 1,
            reconStatus: 'linked',
            reconNote: `委托人已改至第 ${revisionNo} 版，本件照旧按第 ${body.specRevision ?? revisionNo - 1} 版做完`,
            updatedAt: now,
          } as never);
        } else {
          // 退回重排：胎体规格按新版；未涂道次全部标退回，已涂道次留存（旧版依据不动）
          await db.bodies.update(body.id, {
            shape: payload.shape,
            sizeMm: payload.sizeMm,
            specRevision: revisionNo,
            specPolicy: 'reschedule',
            reconStatus: 'linked',
            reconNote: `委托人已改至第 ${revisionNo} 版，本件退回重排：未涂道次退回，已涂道次留存`,
            updatedAt: now,
          } as never);
          const pendingCoats = coats.filter((coat) => coat.state === 'todo' && !coat.returned);
          if (pendingCoats.length > 0) {
            await db.coats.bulkPut(
              pendingCoats.map((coat) => ({ ...coat, returned: true, updatedAt: now })),
            );
          }
        }
      }
    });

    await Promise.all([get().loadCommissions(), bodyStore.loadBodies(), coatStore.loadCoats()]);
  },

  async cancelCommission(id, note) {
    const commission = get().commissions.find((item) => item.id === id);
    if (!commission) return;
    const now = Date.now();
    const bodyStore = useBodyStore.getState();
    const coatStore = useCoatStore.getState();
    const targets = boundBodies(id);

    await db.transaction('rw', db.commissions, db.bodies, db.coats, async () => {
      await db.commissions.update(id, {
        status: 'cancelled' as CommissionStatus,
        cancelledAt: now,
        cancelNote: note,
        updatedAt: now,
      } as never);
      for (const body of targets) {
        const started = isBodyStarted(body, coatsOf(body.id));
        if (!started) {
          // 委托撤掉后没开工的退回
          await db.bodies.update(body.id, {
            returned: true,
            reconStatus: 'unlinked',
            reconNote: '委托已撤且未开工，胎体退回排产',
            updatedAt: now,
          } as never);
        } else {
          // 已髹涂的留着；未涂道次退回，已涂及以后道次留存
          const pendingCoats = coatsOf(body.id).filter((coat) => coat.state === 'todo' && !coat.returned);
          if (pendingCoats.length > 0) {
            await db.coats.bulkPut(pendingCoats.map((coat) => ({ ...coat, returned: true, updatedAt: now })));
          }
          await db.bodies.update(body.id, {
            reconStatus: 'linked',
            reconNote: '委托已撤：已髹涂部分留存',
            updatedAt: now,
          } as never);
        }
      }
    });

    await Promise.all([get().loadCommissions(), bodyStore.loadBodies(), coatStore.loadCoats()]);
  },

  async completeCommission(id) {
    await db.commissions.update(id, { status: 'done' as CommissionStatus, updatedAt: Date.now() } as never);
    await get().loadCommissions();
  },

  async removeCommission(id) {
    // 仅允许删除没有胎体认领的委托；认了单的先解绑，避免留下悬空引用
    if (boundBodies(id).length > 0) {
      throw new Error('该委托已有胎体认单，请先在对账页解绑后再删除');
    }
    await db.commissions.delete(id);
    await get().loadCommissions();
  },

  async bindBody(bodyId, commissionId) {
    const commission = get().commissions.find((item) => item.id === commissionId);
    if (!commission) throw new Error('委托单不存在');
    const bodyStore = useBodyStore.getState();
    const body = bodyStore.bodies.find((item) => item.id === bodyId);
    if (!body) throw new Error('胎体不存在');
    const latest = [...commission.revisions].sort((a, b) => a.revisionNo - b.revisionNo).pop();
    const next: Partial<Body> = {
      commissionId,
      specRevision: latest?.revisionNo ?? 1,
      specPolicy: null,
      returned: false,
      ownerName: body.ownerName || commission.clientName,
      updatedAt: Date.now(),
    };
    // 认单时把前台规格带到胎体（开胎对齐最新版）
    if (latest) {
      next.shape = latest.shape;
      next.sizeMm = latest.sizeMm;
      next.material = commission.material;
    }
    await db.bodies.update(bodyId, next as never);
    await bodyStore.loadBodies();
    await get().recomputeReconcile();
  },

  async unbindBody(bodyId, note = '') {
    const bodyStore = useBodyStore.getState();
    await db.bodies.update(bodyId, {
      commissionId: null,
      reconStatus: 'unlinked',
      reconNote: note || '人工解绑：该胎体无委托单，单列管理',
      specRevision: null,
      specPolicy: null,
      updatedAt: Date.now(),
    } as never);
    await bodyStore.loadBodies();
  },

  async resolveHeld(bodyId, patch) {
    const bodyStore = useBodyStore.getState();
    const body = bodyStore.bodies.find((item) => item.id === bodyId);
    if (!body) return;
    const commission = patch.commissionId ? get().commissionById(patch.commissionId) ?? null : null;
    const candidate: Body = {
      ...body,
      commissionId: patch.commissionId,
      specRevision: patch.specRevision ?? (commission ? Math.max(...commission.revisions.map((r) => r.revisionNo)) : null),
      reconNote: '',
      reconStatus: 'linked',
    };
    const classify = classifyBody(candidate, commission);
    if (classify.status === 'held') {
      // 核对仍不一致：保持挂起，登记人工说明，等人继续判
      await db.bodies.update(bodyId, { reconNote: `${classify.note}${patch.note ? `；人工备注：${patch.note}` : ''}`, updatedAt: Date.now() } as never);
    } else if (!commission) {
      await db.bodies.update(bodyId, {
        commissionId: null,
        reconStatus: 'unlinked',
        reconNote: patch.note || '人工判定为无单胎体',
        specRevision: null,
        specPolicy: null,
        updatedAt: Date.now(),
      } as never);
    } else {
      await db.bodies.update(bodyId, {
        commissionId: commission.id,
        reconStatus: 'linked',
        reconNote: patch.note || '',
        specRevision: candidate.specRevision,
        updatedAt: Date.now(),
      } as never);
    }
    await bodyStore.loadBodies();
  },

  async recomputeReconcile() {
    const bodyStore = useBodyStore.getState();
    const bodies = bodyStore.bodies;
    const commissions = get().commissions;
    const result = reconcile(bodies, commissions);
    const now = Date.now();
    const statusOf = new Map<string, { status: Body['reconStatus']; note: string }>();
    result.linked.forEach((body) => statusOf.set(body.id, { status: 'linked', note: body.reconNote }));
    result.unlinked.forEach((body) =>
      statusOf.set(body.id, { status: 'unlinked', note: body.reconNote || '无委托单号，单列待补' }),
    );
    result.held.forEach((item) => statusOf.set(item.body.id, { status: 'held', note: item.detail }));
    result.retained.forEach((body) => statusOf.set(body.id, { status: 'linked', note: '委托已撤：已髹涂部分留存' }));

    const changed = bodies
      .filter((body) => {
        const target = statusOf.get(body.id);
        return target && (body.reconStatus !== target.status || body.reconNote !== target.note);
      })
      .map((body) => ({
        ...body,
        reconStatus: (statusOf.get(body.id) as { status: Body['reconStatus']; note: string }).status,
        reconNote: (statusOf.get(body.id) as { status: Body['reconStatus']; note: string }).note,
        updatedAt: now,
      }));
    if (changed.length > 0) {
      await db.bodies.bulkPut(changed);
      await bodyStore.loadBodies();
    }
  },
}));

/** 派生选择器：状态过滤（前台台账页使用） */
export function selectCommissionsByStatus(
  commissions: Commission[],
  statuses: CommissionStatus[],
): Commission[] {
  if (statuses.length === 0) return commissions;
  return commissions.filter((commission) => statuses.includes(commission.status));
}
