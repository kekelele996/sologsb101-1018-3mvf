/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑：
 *   v1 → v2：Coat 增加 paintType 索引并回填历史记录
 *   v2 → v3：新增前台 commissions 委托单表；胎体按委托人回填委托单号，
 *            填不出的进入「无单单列」；Coat 增加依据版本 / 退回标记
 * - 业务表的增删改查与整库导入导出
 * - 首次打开自动播种互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Body } from '@/types/body';
import type { Coat, PaintType } from '@/types/coat';
import type { Room } from '@/types/room';
import type { Polish } from '@/types/polish';
import type { Inlay } from '@/types/inlay';
import type { Inspect } from '@/types/inspect';
import type { Commission } from '@/types/commission';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gblacquer';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gblacquer:db-version',
  lastBackupAt: 'gblacquer:last-backup-at',
  uiPrefs: 'gblacquer:ui-prefs',
} as const;

export interface UiPrefs {
  /** 最近选中的胎体 */
  lastBodyId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBodyId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return { lastBodyId: typeof parsed.lastBodyId === 'string' ? parsed.lastBodyId : null };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

/** 记录结构版本与最近备份时间，便于「本地数据」页回显 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

class LacquerDatabase extends Dexie {
  commissions!: Table<Commission, string>;
  bodies!: Table<Body, string>;
  coats!: Table<Coat, string>;
  rooms!: Table<Room, string>;
  polishes!: Table<Polish, string>;
  inlays!: Table<Inlay, string>;
  inspects!: Table<Inspect, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      bodies: 'id, code, material, shape, state, updatedAt',
      coats: 'id, bodyId, seq, state, updatedAt',
      rooms: 'id, bodyId, date, verdict, updatedAt',
      polishes: 'id, bodyId, seq, method, updatedAt',
      inlays: 'id, bodyId, type, position, updatedAt',
      inspects: 'id, bodyId, verdict, date, updatedAt',
    });

    // v2：Coat 增加 paintType 索引；历史记录缺少 paintType 时按「生漆」回填
    this.version(2).stores({
      bodies: 'id, code, material, shape, state, updatedAt',
      coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
      rooms: 'id, bodyId, date, verdict, updatedAt',
      polishes: 'id, bodyId, seq, method, updatedAt',
      inlays: 'id, bodyId, type, position, updatedAt',
      inspects: 'id, bodyId, verdict, date, updatedAt',
    });

    // v3：前台委托单上系统
    // - 新增 commissions 表（前台记委托人、器型、尺寸、交期，与工序台各记各的）
    // - bodies 增加 commissionId / reconStatus 索引；旧胎体按委托人回填委托单
    // - coats 增加 basisRevision 索引；旧道次统一按委托第 1 版回填
    this.version(DB_SCHEMA_VERSION)
      .stores({
        commissions: 'id, code, clientName, status, dueDate, updatedAt',
        bodies: 'id, code, commissionId, reconStatus, material, shape, state, returned, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, basisRevision, returned, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
      })
      .upgrade(async (tx) => {
        // v2 结构补齐（老库停留在更早版本时 Dexie 会依次执行，这里做幂等兜底）
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            const legal: PaintType[] = ['raw', 'color', 'topcoat'];
            if (!legal.includes(coat.paintType)) coat.paintType = 'raw';
            if (typeof coat.needRecheck !== 'boolean') coat.needRecheck = false;
            if (typeof coat.thicknessUm !== 'number') coat.thicknessUm = 40;
          });

        const oldBodies = await tx.table<Body>('bodies').toArray();

        // 旧数据里的胎体缺委托单号：按委托人回填。
        // 同一委托人下的胎体各补一张补录委托单（单号 WT-回填-<胎体号>），
        // 委托人缺失（自藏 / 未填）的回填不出来 —— 进「无单单列」。
        const backfilled: Commission[] = [];
        const bodyCommissionId = new Map<string, string>();
        oldBodies.forEach((body) => {
          const owner = body.ownerName?.trim() ?? '';
          if (owner.length === 0) return;
          const commissionId = `comm_backfill_${body.id}`;
          bodyCommissionId.set(body.id, commissionId);
          backfilled.push({
            id: commissionId,
            code: `WT-回填-${body.code}`,
            clientName: owner,
            contact: '',
            material: body.material,
            dueDate: '',
            status: 'active',
            revisions: [
              {
                revisionNo: 1,
                shape: body.shape,
                sizeMm: body.sizeMm,
                note: '旧数据升级：按委托人自动补录的委托单',
                changedAt: body.createdAt,
              },
            ],
            cancelledAt: null,
            cancelNote: '',
            createdAt: body.createdAt,
            updatedAt: Date.now(),
          });
        });
        if (backfilled.length > 0) await tx.table<Commission>('commissions').bulkPut(backfilled);

        await tx
          .table<Body>('bodies')
          .toCollection()
          .modify((body) => {
            // 旧库无 commissionId 字段（undefined）：按委托人回填，填不出来为 null（无单单列）
            if (body.commissionId === undefined) body.commissionId = bodyCommissionId.get(body.id) ?? null;
            body.reconStatus = body.commissionId ? 'linked' : 'unlinked';
            body.reconNote = body.commissionId ? '' : '旧数据无委托单号，且按委托人回填不出来，单列待补';
            body.specRevision = body.commissionId ? 1 : null;
            body.specPolicy = null;
            body.returned = false;
          });

        // 旧道次：认到委托的按第 1 版回填依据版本，认不到的留 null；均不在退回态
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            const commissionId = bodyCommissionId.get(coat.bodyId);
            if (coat.basisRevision === undefined) coat.basisRevision = commissionId ? 1 : null;
            if (typeof coat.returned !== 'boolean') coat.returned = false;
          });
      });
  }
}

export const db = new LacquerDatabase();

/** 业务表清单，事务中统一引用 */
const TABLE_LIST = [db.commissions, db.bodies, db.coats, db.rooms, db.polishes, db.inlays, db.inspects];

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.bodies.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 四层互相引用：Commission → Body →（Coat / Room / Polish / Inlay）→ Inspect，
   id 固定便于深链命中；覆盖认单、改版照旧、改版重排、撤单留存、有单无胎、无单单列、挂起七种情形。 */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();

  const commissions: Commission[] = [
    {
      id: 'comm_01',
      code: 'WT-2601',
      clientName: '陈氏委托',
      contact: '陈师傅 138****0101',
      material: 'wood',
      dueDate: '2026-04-20',
      status: 'active',
      revisions: [
        { revisionNo: 1, shape: 'bowl', sizeMm: 152, note: '初版：木胎碗', changedAt: now - 86400000 * 13 },
        { revisionNo: 2, shape: 'bowl', sizeMm: 140, note: '委托人要求口径收小至 140mm', changedAt: now - 86400000 * 6 },
      ],
      cancelledAt: null,
      cancelNote: '',
      createdAt: now - 86400000 * 13,
      updatedAt: now - 86400000 * 6,
    },
    {
      id: 'comm_02',
      code: 'WT-2602',
      clientName: '林氏定制',
      contact: '',
      material: 'lacquered',
      dueDate: '2026-04-12',
      status: 'active',
      revisions: [
        { revisionNo: 1, shape: 'box', sizeMm: 96, note: '初版：脱胎盒', changedAt: now - 86400000 * 10 },
        { revisionNo: 2, shape: 'plate', sizeMm: 120, note: '改器型：盒改盘，尺寸放大', changedAt: now - 86400000 * 4 },
      ],
      cancelledAt: null,
      cancelNote: '',
      createdAt: now - 86400000 * 10,
      updatedAt: now - 86400000 * 4,
    },
    {
      id: 'comm_03',
      code: 'WT-2603',
      clientName: '市工艺美术馆',
      contact: '周老师',
      material: 'metal',
      dueDate: '2026-03-15',
      status: 'done',
      revisions: [{ revisionNo: 1, shape: 'vase', sizeMm: 210, note: '初版：金属胎赏瓶', changedAt: now - 86400000 * 31 }],
      cancelledAt: null,
      cancelNote: '',
      createdAt: now - 86400000 * 31,
      updatedAt: now - 86400000 * 4,
    },
    {
      id: 'comm_04',
      code: 'WT-2604',
      clientName: '吴氏委托',
      contact: '',
      material: 'wood',
      dueDate: '2026-04-30',
      status: 'cancelled',
      revisions: [{ revisionNo: 1, shape: 'plate', sizeMm: 180, note: '初版：木胎大盘', changedAt: now - 86400000 * 8 }],
      cancelledAt: now - 86400000 * 3,
      cancelNote: '委托人因故撤单：已髹涂部分留存，未开工道次退回',
      createdAt: now - 86400000 * 8,
      updatedAt: now - 86400000 * 3,
    },
    {
      id: 'comm_05',
      code: 'WT-2605',
      clientName: '郑氏委托',
      contact: '',
      material: 'wood',
      dueDate: '2026-05-10',
      status: 'active',
      revisions: [{ revisionNo: 1, shape: 'box', sizeMm: 110, note: '初版：木胎捧盒，尚未开胎', changedAt: now - 86400000 * 2 }],
      cancelledAt: null,
      cancelNote: '',
      createdAt: now - 86400000 * 2,
      updatedAt: now - 86400000 * 2,
    },
  ];

  const bodies: Body[] = [
    {
      id: 'body_01',
      code: 'LQ-2401',
      material: 'wood',
      shape: 'bowl',
      sizeMm: 152,
      ownerName: '陈氏委托',
      state: 'coating',
      commissionId: 'comm_01',
      reconStatus: 'linked',
      reconNote: '',
      specRevision: 1,
      specPolicy: 'finishOld',
      returned: false,
      createdAt: now - 86400000 * 12,
      updatedAt: now - 86400000 * 2,
    },
    {
      id: 'body_02',
      code: 'LQ-2402',
      material: 'lacquered',
      shape: 'plate',
      sizeMm: 120,
      ownerName: '林氏定制',
      state: 'drying',
      commissionId: 'comm_02',
      reconStatus: 'linked',
      reconNote: '',
      specRevision: 2,
      specPolicy: 'reschedule',
      returned: false,
      createdAt: now - 86400000 * 9,
      updatedAt: now - 86400000,
    },
    {
      id: 'body_03',
      code: 'LQ-2403',
      material: 'metal',
      shape: 'vase',
      sizeMm: 210,
      ownerName: '市工艺美术馆',
      state: 'done',
      commissionId: 'comm_03',
      reconStatus: 'linked',
      reconNote: '',
      specRevision: 1,
      specPolicy: null,
      returned: false,
      createdAt: now - 86400000 * 30,
      updatedAt: now - 86400000 * 4,
    },
    {
      id: 'body_04',
      code: 'LQ-2404',
      material: 'wood',
      shape: 'plate',
      sizeMm: 180,
      ownerName: '吴氏委托',
      state: 'coating',
      commissionId: 'comm_04',
      reconStatus: 'linked',
      reconNote: '',
      specRevision: 1,
      specPolicy: null,
      returned: false,
      createdAt: now - 86400000 * 7,
      updatedAt: now - 86400000 * 3,
    },
    {
      id: 'body_05',
      code: 'LQ-2405',
      material: 'wood',
      shape: 'vase',
      sizeMm: 160,
      ownerName: '',
      state: 'pending',
      commissionId: null,
      reconStatus: 'unlinked',
      reconNote: '工作室自存胎，无委托单',
      specRevision: null,
      specPolicy: null,
      returned: false,
      createdAt: now - 86400000 * 2,
      updatedAt: now - 86400000 * 2,
    },
    {
      id: 'body_06',
      code: 'LQ-2406',
      material: 'wood',
      shape: 'bowl',
      sizeMm: 130,
      ownerName: '手写单已褪色',
      state: 'pending',
      commissionId: 'comm_missing_seed',
      reconStatus: 'held',
      reconNote: '胎体认的委托单号在前台台账中查不到',
      specRevision: 1,
      specPolicy: null,
      returned: false,
      createdAt: now - 86400000,
      updatedAt: now - 86400000,
    },
  ];

  const coats: Coat[] = [
    // body_01：委托已改版到 v2，本件照旧做完 —— 已落道次写明依据第 1 版
    { id: 'coat_0101', bodyId: 'body_01', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-02', thicknessUm: 40, state: 'done', needRecheck: false, basisRevision: 1, returned: false, createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 10 },
    { id: 'coat_0102', bodyId: 'body_01', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '2026-03-06', thicknessUm: 45, state: 'toPolish', needRecheck: true, basisRevision: 1, returned: false, createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 2 },
    { id: 'coat_0103', bodyId: 'body_01', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-12', thicknessUm: 30, state: 'todo', needRecheck: false, basisRevision: 2, returned: false, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    // body_02：盒改盘并选「退回重排」—— 第 1 道已涂保留（依据 v1），第 2 道未涂标退回
    { id: 'coat_0201', bodyId: 'body_02', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-03', thicknessUm: 35, state: 'coated', needRecheck: false, basisRevision: 1, returned: false, createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 7 },
    { id: 'coat_0202', bodyId: 'body_02', seq: 2, paintType: 'color', colorName: '赭石', coatDate: '2026-03-08', thicknessUm: 42, state: 'todo', needRecheck: false, basisRevision: 1, returned: true, createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'coat_0301', bodyId: 'body_03', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-02-10', thicknessUm: 38, state: 'done', needRecheck: false, basisRevision: 1, returned: false, createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 25 },
    { id: 'coat_0302', bodyId: 'body_03', seq: 2, paintType: 'color', colorName: '石绿', coatDate: '2026-02-18', thicknessUm: 44, state: 'done', needRecheck: false, basisRevision: 1, returned: false, createdAt: now - 86400000 * 20, updatedAt: now - 86400000 * 18 },
    { id: 'coat_0303', bodyId: 'body_03', seq: 3, paintType: 'topcoat', colorName: '描金', coatDate: '2026-02-26', thicknessUm: 28, state: 'done', needRecheck: false, basisRevision: 1, returned: false, createdAt: now - 86400000 * 14, updatedAt: now - 86400000 * 4 },
    // body_04：撤单 —— 已髹涂的第 1 道留存，未开工的第 2 道退回
    { id: 'coat_0401', bodyId: 'body_04', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-05', thicknessUm: 42, state: 'coated', needRecheck: false, basisRevision: 1, returned: false, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 5 },
    { id: 'coat_0402', bodyId: 'body_04', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '', thicknessUm: 40, state: 'todo', needRecheck: false, basisRevision: 1, returned: true, createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 3 },
  ];

  const rooms: Room[] = [
    { id: 'room_0101', bodyId: 'body_01', date: '2026-03-03', tempC: 24, humidityPct: 78, inAt: '09:00', outAt: '21:00', verdict: 'suitable', createdAt: now - 86400000 * 10, updatedAt: now - 86400000 * 10 },
    { id: 'room_0102', bodyId: 'body_01', date: '2026-03-07', tempC: 27, humidityPct: 56, inAt: '08:30', outAt: '20:00', verdict: 'dry', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    { id: 'room_0201', bodyId: 'body_02', date: '2026-03-05', tempC: 23, humidityPct: 91, inAt: '10:00', outAt: '22:30', verdict: 'wet', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'room_0301', bodyId: 'body_03', date: '2026-02-20', tempC: 25, humidityPct: 76, inAt: '09:30', outAt: '21:30', verdict: 'suitable', createdAt: now - 86400000 * 18, updatedAt: now - 86400000 * 18 },
  ];

  const polishes: Polish[] = [
    { id: 'polish_0101', bodyId: 'body_01', seq: 1, grit: 600, method: 'water', durationMin: 35, operator: '王丽', createdAt: now - 86400000 * 9, updatedAt: now - 86400000 * 9 },
    { id: 'polish_0102', bodyId: 'body_01', seq: 2, grit: 1500, method: 'burnish', durationMin: 45, operator: '王丽', createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
    { id: 'polish_0201', bodyId: 'body_02', seq: 1, grit: 800, method: 'water', durationMin: 30, operator: '李成', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'polish_0301', bodyId: 'body_03', seq: 3, grit: 2000, method: 'burnish', durationMin: 60, operator: '王丽', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 * 4 },
  ];

  const inlays: Inlay[] = [
    { id: 'inlay_0101', bodyId: 'body_01', type: 'nacre', pattern: '缠枝莲', position: '外壁', materialNote: '0.8mm 螺钿片，刻纹嵌贴', createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 7 },
    { id: 'inlay_0201', bodyId: 'body_02', type: 'eggshell', pattern: '云纹', position: '盖面', materialNote: '鸭蛋壳拼贴后髹漆磨显', createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inlay_0301', bodyId: 'body_03', type: 'incisedGold', pattern: '折枝花', position: '通体', materialNote: '戗金，金粉入刻线', createdAt: now - 86400000 * 12, updatedAt: now - 86400000 * 12 },
    { id: 'inlay_0302', bodyId: 'body_03', type: 'goldTrace', pattern: '诗文', position: '外壁', materialNote: '描金，泥金细描', createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 11 },
  ];

  const inspects: Inspect[] = [
    { id: 'inspect_0101', bodyId: 'body_03', verdict: 'pass', defectNote: '', inspector: '周衡', date: '2026-03-02', defectCoatSeq: null, defectRoomId: null, createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inspect_0102', bodyId: 'body_02', verdict: 'rework', defectNote: '起皱（荫干过快）', inspector: '周衡', date: '2026-03-08', defectCoatSeq: 2, defectRoomId: 'room_0201', createdAt: now - 86400000, updatedAt: now - 86400000 },
  ];

  await db.transaction('rw', TABLE_LIST, async () => {
    await db.commissions.bulkPut(commissions);
    await db.bodies.bulkPut(bodies);
    await db.coats.bulkPut(coats);
    await db.rooms.bulkPut(rooms);
    await db.polishes.bulkPut(polishes);
    await db.inlays.bulkPut(inlays);
    await db.inspects.bulkPut(inspects);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface LacquerSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  commissions: Commission[];
  bodies: Body[];
  coats: Coat[];
  rooms: Room[];
  polishes: Polish[];
  inlays: Inlay[];
  inspects: Inspect[];
}

export async function exportSnapshot(): Promise<LacquerSnapshot> {
  const [commissions, bodies, coats, rooms, polishes, inlays, inspects] = await Promise.all([
    db.commissions.toArray(),
    db.bodies.toArray(),
    db.coats.toArray(),
    db.rooms.toArray(),
    db.polishes.toArray(),
    db.inlays.toArray(),
    db.inspects.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    commissions,
    bodies,
    coats,
    rooms,
    polishes,
    inlays,
    inspects,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<LacquerSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof LacquerSnapshot> = ['commissions', 'bodies', 'coats', 'rooms', 'polishes', 'inlays', 'inspects'];
  // commissions 为 v3 新增：老备份没有时按空集合兼容
  if (snapshot.commissions === undefined) snapshot.commissions = [];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

export async function importSnapshot(snapshot: LacquerSnapshot): Promise<void> {
  await clearAllTables();
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.commissions.bulkPut(snapshot.commissions ?? []);
    await db.bodies.bulkPut(snapshot.bodies);
    await db.coats.bulkPut(snapshot.coats);
    await db.rooms.bulkPut(snapshot.rooms);
    await db.polishes.bulkPut(snapshot.polishes);
    await db.inlays.bulkPut(snapshot.inlays);
    await db.inspects.bulkPut(snapshot.inspects);
  });
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await Promise.all([
      db.commissions.clear(),
      db.bodies.clear(),
      db.coats.clear(),
      db.rooms.clear(),
      db.polishes.clear(),
      db.inlays.clear(),
      db.inspects.clear(),
    ]);
  });
}

/** 清空并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [commissions, bodies, coats, rooms, polishes, inlays, inspects] = await Promise.all([
    db.commissions.count(),
    db.bodies.count(),
    db.coats.count(),
    db.rooms.count(),
    db.polishes.count(),
    db.inlays.count(),
    db.inspects.count(),
  ]);
  return { commissions, bodies, coats, rooms, polishes, inlays, inspects };
}

/* ------------------------------ 级联删除 ------------------------------ */

export async function removeBodyCascade(bodyId: string): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.coats.where('bodyId').equals(bodyId).delete();
    await db.rooms.where('bodyId').equals(bodyId).delete();
    await db.polishes.where('bodyId').equals(bodyId).delete();
    await db.inlays.where('bodyId').equals(bodyId).delete();
    await db.inspects.where('bodyId').equals(bodyId).delete();
    await db.bodies.delete(bodyId);
  });
}
