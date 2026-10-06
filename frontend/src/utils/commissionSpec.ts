/**
 * 委托规格 → 髹涂施工建议
 * 委托人改版（器型 / 尺寸变化）后，湿膜厚度建议与荫干时长建议一律作废，
 * 按当前认到的委托版本重新计算；道次页展示的建议只认这里的结果。
 */
import type { BodyShape } from '@/types/body';
import type { Commission } from '@/types/commission';
import { latestRevision, revisionAt } from '@/types/commission';
import { dryingHours } from '@/utils/humidity';

/** 不同器型的湿膜基准厚度（微米）：大件厚胎打底厚，盘片类宜薄 */
const SHAPE_BASE_THICKNESS: Record<BodyShape, number> = {
  bowl: 40,
  plate: 35,
  box: 38,
  vase: 42,
};

const WET_FILM_MIN = 20;
const WET_FILM_MAX = 80;

/**
 * 按器型与尺寸建议湿膜厚度（微米，取整）。
 * 以 120mm 为基准尺寸，每差 120mm 增减一档（±10%），夹在 20~80μm。
 */
export function suggestWetFilmUm(shape: BodyShape, sizeMm: number): number {
  const base = SHAPE_BASE_THICKNESS[shape] ?? 40;
  const factor = 1 + (sizeMm - 120) / 1200;
  const clamped = Math.max(0.7, Math.min(1.4, factor));
  const value = Math.round(base * clamped);
  return Math.min(WET_FILM_MAX, Math.max(WET_FILM_MIN, value));
}

/** 默认荫房环境（无荫房记录时按标准阴房 24℃ / 75% 估算） */
export const DEFAULT_SPEC_ENV = { tempC: 24, humidityPct: 75 } as const;

export interface SpecBasis {
  /** 依据的委托版本号；无单为 null */
  revisionNo: number | null;
  shape: BodyShape;
  sizeMm: number;
  /** 建议湿膜厚度 μm */
  thicknessUm: number;
}

/**
 * 取一件胎体当前应遵循的规格与建议。
 * - 有单且胎体记录了依据版本：按该版本（照旧做完的件仍按旧版）
 * - 有单未记录版本：按委托最新版
 * - 无单：回退到调用方给定的胎体自身器型尺寸
 */
export function resolveSpecBasis(
  commission: Commission | null | undefined,
  fallback: { shape: BodyShape; sizeMm: number; specRevision: number | null },
): SpecBasis {
  if (!commission) {
    return {
      revisionNo: null,
      shape: fallback.shape,
      sizeMm: fallback.sizeMm,
      thicknessUm: suggestWetFilmUm(fallback.shape, fallback.sizeMm),
    };
  }
  const revision =
    (fallback.specRevision !== null ? revisionAt(commission, fallback.specRevision) : undefined) ??
    latestRevision(commission);
  if (!revision) {
    return {
      revisionNo: null,
      shape: fallback.shape,
      sizeMm: fallback.sizeMm,
      thicknessUm: suggestWetFilmUm(fallback.shape, fallback.sizeMm),
    };
  }
  return {
    revisionNo: revision.revisionNo,
    shape: revision.shape,
    sizeMm: revision.sizeMm,
    thicknessUm: suggestWetFilmUm(revision.shape, revision.sizeMm),
  };
}

/**
 * 按规格与荫房环境估算建议荫干时长（小时）。
 * 改版后随湿膜建议一起作废重算。
 */
export function suggestSpecDryingHours(
  basis: SpecBasis,
  env: { tempC: number; humidityPct: number } = DEFAULT_SPEC_ENV,
): number {
  return dryingHours(env.tempC, env.humidityPct, basis.thicknessUm);
}
