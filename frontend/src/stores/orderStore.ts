/**
 * 委托单状态管理（Zustand）—— 接单前台
 * 维护委托单台账、规格变更版本、撤单处理、按编号对账与按委托人回填。
 * 前台写入（建单）失败只重试委托单自己那份（幂等 put），不重放胎体回写。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import { retryIdempotentWrite } from '@/utils/retry';
import { suggestThicknessUm } from '@/utils/humidity';
import type { Body, BodyShape } from '@/types/body';
import type { Order, OrderDraft, OrderVersion } from '@/types/order';
import { useBodyStore } from './bodyStore';
import { useCoatStore } from './coatStore';

interface OrderStoreState {
  orders: Order[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadOrders: () => Promise<void>;
  orderById: (id: string) => Order | undefined;
  orderByNo: (orderNo: string) => Order | undefined;
  createOrder: (draft: OrderDraft) => Promise<Order>;
  updateOrder: (id: string, patch: Partial<Order>) => Promise<void>;
  /** 委托人中途改尺寸器型：累加版本；未开工件退回重排，已开工件照旧做完 */
  changeSpec: (
    id: string,
    shape: BodyShape,
    sizeMm: number,
    changeNote: string,
  ) => Promise<{ rescheduled: string[]; finishAsIs: string[] }>;
  /** 委托撤单：未开工件退回，已髹涂件留着 */
  cancelOrder: (id: string) => Promise<{ returned: string[]; kept: string[] }>;
  completeOrder: (id: string) => Promise<void>;
  removeOrder: (id: string) => Promise<void>;
  linkBody: (bodyId: string, orderId: string) => Promise<void>;
  unlinkBody: (bodyId: string) => Promise<void>;
  /** 按编号对账：对不上号的胎体挂起等人判 */
  runReconcile: () => Promise<void>;
  /** 按委托人回填委托单号：填不出的单列，返回已链接与未匹配编号 */
  runBackfill: () => Promise<{ linked: string[]; unmatched: string[] }>;
}

/** 胎体是否已开工：存在任一非「待涂」道次即视为已髹涂 */
async function bodyStarted(bodyId: string): Promise<boolean> {
  const coats = await db.coats.where('bodyId').equals(bodyId).toArray();
  return coats.some((coat) => coat.state !== 'todo');
}

/** 退回重排：按新版规格重算湿膜厚度（荫干时长随之作废重算），器型尺寸追到新版，版本追到最新 */
async function rescheduleBody(body: Body, spec: { shape: BodyShape; sizeMm: number; version: number }): Promise<void> {
  const coats = await db.coats.where('bodyId').equals(body.id).sortBy('seq');
  const now = Date.now();
  const thicknessUm = suggestThicknessUm(spec.shape, spec.sizeMm);
  if (coats.length > 0) {
    await db.coats.bulkPut(
      coats.map((coat) => ({ ...coat, thicknessUm, updatedAt: now })),
    );
  }
  await db.bodies.update(
    body.id,
    {
      shape: spec.shape,
      sizeMm: spec.sizeMm,
      orderId: body.orderId,
      orderNo: body.orderNo,
      basedOnVersion: spec.version,
      returned: false,
      suspended: false,
      suspendedReason: '',
      updatedAt: now,
    } as never,
  );
}

export const useOrderStore = create<OrderStoreState>((set, get) => ({
  orders: [],
  loading: false,
  ready: false,
  error: '',

  async loadOrders() {
    set({ loading: true });
    try {
      const orders = await db.orders.toArray();
      orders.sort((a, b) => b.updatedAt - a.updatedAt);
      set({ orders, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '委托单读取失败' });
    }
  },

  orderById(id) {
    return get().orders.find((order) => order.id === id);
  },

  orderByNo(orderNo) {
    return get().orders.find((order) => order.orderNo === orderNo);
  },

  async createOrder(draft) {
    const now = Date.now();
    const order: Order = {
      ...draft,
      id: createId('order'),
      status: 'active',
      version: 1,
      versions: [{ version: 1, shape: draft.shape, sizeMm: draft.sizeMm, changedAt: now, changeNote: '建单' }],
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    // 前台写入：失败只重试委托单自己这份（同一主键 put 幂等，不产生重复单）
    await retryIdempotentWrite(() => db.orders.put(order));
    await get().loadOrders();
    return order;
  },

  async updateOrder(id, patch) {
    await db.orders.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadOrders();
  },

  async changeSpec(id, shape, sizeMm, changeNote) {
    const order = get().orders.find((item) => item.id === id);
    if (!order) return { rescheduled: [], finishAsIs: [] };
    const now = Date.now();
    const next: OrderVersion = { version: order.version + 1, shape, sizeMm, changedAt: now, changeNote };
    const updated: Order = {
      ...order,
      shape,
      sizeMm,
      version: next.version,
      versions: [...order.versions, next],
      updatedAt: now,
    };
    await db.orders.put(updated);

    const bodies = await db.bodies.where('orderId').equals(id).toArray();
    const rescheduled: string[] = [];
    const finishAsIs: string[] = [];
    for (const body of bodies) {
      if (await bodyStarted(body.id)) {
        // 已开工：照旧做完，依据版本保留在旧版（basedOnVersion 不变），道次页据此标注
        finishAsIs.push(body.code);
      } else {
        // 未开工：退回重排，湿膜厚度与荫干时长按新版作废重算
        await rescheduleBody(body, { shape, sizeMm, version: next.version });
        rescheduled.push(body.code);
      }
    }
    await get().loadOrders();
    await useBodyStore.getState().loadBodies();
    await useCoatStore.getState().loadCoats();
    return { rescheduled, finishAsIs };
  },

  async cancelOrder(id) {
    const order = get().orders.find((item) => item.id === id);
    if (!order) return { returned: [], kept: [] };
    const now = Date.now();
    await db.orders.update(id, { status: 'cancelled', cancelledAt: now, updatedAt: now } as never);

    const bodies = await db.bodies.where('orderId').equals(id).toArray();
    const returned: string[] = [];
    const kept: string[] = [];
    for (const body of bodies) {
      if (await bodyStarted(body.id)) {
        // 已髹涂：留着继续做完
        kept.push(body.code);
      } else {
        // 未开工：退回
        await db.bodies.update(body.id, { returned: true, updatedAt: now } as never);
        returned.push(body.code);
      }
    }
    await get().loadOrders();
    await useBodyStore.getState().loadBodies();
    return { returned, kept };
  },

  async completeOrder(id) {
    await db.orders.update(id, { status: 'done', updatedAt: Date.now() } as never);
    await get().loadOrders();
  },

  async removeOrder(id) {
    // 删单不删胎体：解除关联，胎体列入待回填
    const now = Date.now();
    const bodies = await db.bodies.where('orderId').equals(id).toArray();
    await db.transaction('rw', db.orders, db.bodies, async () => {
      await db.orders.delete(id);
      for (const body of bodies) {
        await db.bodies.update(
          body.id,
          { orderId: null, orderNo: '', basedOnVersion: 1, suspended: false, suspendedReason: '', updatedAt: now } as never,
        );
      }
    });
    await get().loadOrders();
    await useBodyStore.getState().loadBodies();
  },

  async linkBody(bodyId, orderId) {
    const order = get().orders.find((item) => item.id === orderId);
    if (!order) return;
    const now = Date.now();
    await db.bodies.update(
      bodyId,
      {
        orderId,
        orderNo: order.orderNo,
        basedOnVersion: order.version,
        suspended: false,
        suspendedReason: '',
        returned: false,
        updatedAt: now,
      } as never,
    );
    await get().loadOrders();
    await useBodyStore.getState().loadBodies();
  },

  async unlinkBody(bodyId) {
    const now = Date.now();
    await db.bodies.update(
      bodyId,
      { orderId: null, orderNo: '', basedOnVersion: 1, suspended: false, suspendedReason: '', updatedAt: now } as never,
    );
    await get().loadOrders();
    await useBodyStore.getState().loadBodies();
  },

  async runReconcile() {
    const orders = await db.orders.toArray();
    const bodies = await db.bodies.toArray();
    const now = Date.now();
    for (const body of bodies) {
      if (body.returned) {
        await db.bodies.update(body.id, { suspended: false, suspendedReason: '', updatedAt: now } as never);
        continue;
      }
      if (!body.orderNo) {
        // 缺委托单号：不挂起，列入待回填
        await db.bodies.update(body.id, { suspended: false, suspendedReason: '', updatedAt: now } as never);
        continue;
      }
      const matched = orders.some((order) => order.orderNo === body.orderNo);
      if (matched) {
        await db.bodies.update(body.id, { suspended: false, suspendedReason: '', updatedAt: now } as never);
      } else {
        await db.bodies.update(
          body.id,
          {
            suspended: true,
            suspendedReason: `委托单号 ${body.orderNo} 在委托单中不存在，需人工判定`,
            updatedAt: now,
          } as never,
        );
      }
    }
    await get().loadOrders();
    await useBodyStore.getState().loadBodies();
  },

  async runBackfill() {
    const orders = await db.orders.toArray();
    const bodies = await db.bodies.toArray();
    const now = Date.now();
    const linked: string[] = [];
    const unmatched: string[] = [];
    for (const body of bodies) {
      if (body.orderNo || body.returned) continue;
      const matched = orders.filter(
        (order) => order.ownerName === body.ownerName && order.status !== 'cancelled',
      );
      if (matched.length === 1) {
        const order = matched[0] as Order;
        await db.bodies.update(
          body.id,
          { orderId: order.id, orderNo: order.orderNo, basedOnVersion: order.version, updatedAt: now } as never,
        );
        linked.push(body.code);
      } else {
        unmatched.push(body.code);
      }
    }
    await get().loadOrders();
    await useBodyStore.getState().loadBodies();
    return { linked, unmatched };
  },
}));
