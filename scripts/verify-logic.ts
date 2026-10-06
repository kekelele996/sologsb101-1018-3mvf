/* 纯逻辑冒烟验证：对账分类 + 改版建议重算 + 撤单/重排规则（不碰 IndexedDB） */
import { reconcile } from '../frontend/src/utils/reconcile';
import { suggestWetFilmUm, resolveSpecBasis, suggestSpecDryingHours } from '../frontend/src/utils/commissionSpec';
import type { Body } from '../frontend/src/types/body';
import type { Commission } from '../frontend/src/types/commission';

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

const now = Date.now();
function body(partial: Partial<Body>): Body {
  return {
    id: 'b', code: 'LQ-1', material: 'wood', shape: 'bowl', sizeMm: 120, ownerName: '',
    state: 'pending', commissionId: null, reconStatus: 'unlinked', reconNote: '',
    specRevision: null, specPolicy: null, returned: false, createdAt: now, updatedAt: now,
    ...partial,
  };
}
function commission(partial: Partial<Commission>): Commission {
  return {
    id: 'c', code: 'WT-1', clientName: '甲', contact: '', material: 'wood', dueDate: '2026-05-01',
    status: 'active', revisions: [{ revisionNo: 1, shape: 'bowl', sizeMm: 120, note: '', changedAt: now }],
    cancelledAt: null, cancelNote: '', createdAt: now, updatedAt: now, ...partial,
  };
}

console.log('1) 湿膜建议随尺寸 / 器型重算');
const t1 = suggestWetFilmUm('bowl', 120);
const t2 = suggestWetFilmUm('bowl', 240);
const t3 = suggestWetFilmUm('plate', 120);
assert(t1 > 0 && t2 > t1, `大碗（${t2}μm）比小碗（${t1}μm）厚`);
assert(t3 < t1, `盘（${t3}μm）比碗（${t1}μm）薄`);
const h1 = suggestSpecDryingHours(resolveSpecBasis(null, { shape: 'bowl', sizeMm: 120, specRevision: null }));
const h2 = suggestSpecDryingHours(resolveSpecBasis(null, { shape: 'bowl', sizeMm: 240, specRevision: null }));
assert(h2 > h1, `厚膜荫干更久（${h1}h → ${h2}h）`);

console.log('2) 对账分类');
{
  const c1 = commission({ id: 'c1' });
  const c2 = commission({ id: 'c2', status: 'cancelled' });
  const c3 = commission({ id: 'c3', revisions: [
    { revisionNo: 1, shape: 'bowl', sizeMm: 120, note: '', changedAt: now },
    { revisionNo: 2, shape: 'vase', sizeMm: 200, note: '改', changedAt: now },
  ] });
  const c4 = commission({ id: 'c4', revisions: [
    { revisionNo: 1, shape: 'bowl', sizeMm: 120, note: '', changedAt: now },
    { revisionNo: 2, shape: 'vase', sizeMm: 200, note: '改', changedAt: now },
  ] });
  const c5 = commission({ id: 'c5' });
  const bodies = [
    body({ id: 'linked', commissionId: 'c1', reconStatus: 'linked', specRevision: 1 }),
    body({ id: 'missing', commissionId: 'ghost', reconStatus: 'linked', specRevision: 1 }),
    body({ id: 'dupA', commissionId: 'c5', reconStatus: 'linked', specRevision: 1 }),
    body({ id: 'dupB', commissionId: 'c5', reconStatus: 'linked', specRevision: 1 }),
    body({ id: 'none' }),
    body({ id: 'mismatch', commissionId: 'c3', reconStatus: 'linked', specRevision: 1, shape: 'box', sizeMm: 90 }),
    body({ id: 'stale', commissionId: 'c4', reconStatus: 'linked', specRevision: 1 }),
    body({ id: 'retained', commissionId: 'c2', reconStatus: 'linked', specRevision: 1 }),
    body({ id: 'back', commissionId: 'c1', returned: true }),
  ];
  const r = reconcile(bodies, [c1, c2, c3, c4, c5]);
  assert(r.linked.some((b) => b.id === 'linked'), '一致件 → linked');
  assert(r.held.some((h) => h.body.id === 'missing' && h.reason === 'missing'), '有号无单 → 挂起');
  assert(r.held.some((h) => h.body.id === 'dupA' && h.reason === 'duplicate')
    && r.held.some((h) => h.body.id === 'dupB' && h.reason === 'duplicate'), '一单多认 → 两件都挂起');
  assert(r.held.some((h) => h.body.id === 'mismatch' && h.reason === 'mismatch'), '规格不符 → 挂起');
  assert(r.held.some((h) => h.body.id === 'stale' && h.reason === 'staleRevision'), '改版未选口径 → 挂起');
  assert(r.retained.some((b) => b.id === 'retained'), '撤单已开工件 → 留存（不挂起）');
  assert(r.unlinked.some((b) => b.id === 'none'), '无单胎体 → 无单单列');
  assert(!r.linked.some((b) => b.id === 'back') && !r.held.some((h) => h.body.id === 'back'), '退回件不参与在制对账');
  assert(r.unbound.length === 0, '在制单均已被认');
}

console.log('3) 有单无胎');
{
  const c = commission({ id: 'cX' });
  const r = reconcile([body({ id: 'x', commissionId: 'other' })], [c]);
  assert(r.unbound.some((item) => item.id === 'cX'), '在制委托没胎体认 → 有单无胎');
}

console.log('4) 照旧做完：旧版依据被 resolveSpecBasis 保留');
{
  const c = commission({ id: 'c', revisions: [
    { revisionNo: 1, shape: 'bowl', sizeMm: 120, note: '', changedAt: now },
    { revisionNo: 2, shape: 'vase', sizeMm: 200, note: '改', changedAt: now },
  ] });
  const oldBasis = resolveSpecBasis(c, { shape: 'bowl', sizeMm: 120, specRevision: 1 });
  const newBasis = resolveSpecBasis(c, { shape: 'vase', sizeMm: 200, specRevision: 2 });
  assert(oldBasis.revisionNo === 1 && oldBasis.sizeMm === 120, '照旧件仍按第 1 版规格');
  assert(newBasis.revisionNo === 2 && newBasis.sizeMm === 200, '重排件按第 2 版规格');
  assert(newBasis.thicknessUm !== oldBasis.thicknessUm, '两版湿膜建议不同（旧建议作废重算）');
}

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
