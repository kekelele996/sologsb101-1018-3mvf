/**
 * /coats 髹涂道次编排
 * 拖拽调整道次先后、批量改漆种与状态、同器型自动带出上次漆种与间隔建议。
 * 消费 Coat、Body；复用 <StageTag>、<FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  PlusOutlined,
  RedoOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import StageTag from '@/components/common/StageTag';
import { useCoatProgress } from '@/hooks/useCoatProgress';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useCommissionStore } from '@/stores/commissionStore';
import {
  COAT_STATE_LABEL,
  COAT_STATE_OPTIONS,
  COLOR_NAME_OPTIONS,
  PAINT_TYPE_LABEL,
  PAINT_TYPE_OPTIONS,
  createEmptyCoatDraft,
  type Coat,
  type CoatDraft,
  type CoatState,
  type PaintType,
} from '@/types/coat';
import { BODY_SHAPE_LABEL, RECON_STATUS_COLOR, RECON_STATUS_LABEL } from '@/types/body';
import { CHANGE_POLICY_LABEL, COMMISSION_STATUS_COLOR, COMMISSION_STATUS_LABEL } from '@/types/commission';
import { suggestIntervalHours } from '@/utils/humidity';

const FILTER_KEYS = ['paintType', 'state'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'paintType', label: '漆种', options: PAINT_TYPE_OPTIONS },
  { key: 'state', label: '状态', options: COAT_STATE_OPTIONS },
];

export default function CoatBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CoatDraft>();

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const coats = useCoatStore((state) => state.coats);
  const createCoat = useCoatStore((state) => state.createCoat);
  const updateCoat = useCoatStore((state) => state.updateCoat);
  const removeCoat = useCoatStore((state) => state.removeCoat);
  const batchUpdate = useCoatStore((state) => state.batchUpdate);
  const advanceState = useCoatStore((state) => state.advanceState);
  const reorderCoats = useCoatStore((state) => state.reorderCoats);
  const restoreReturned = useCoatStore((state) => state.restoreReturned);
  const nextSeq = useCoatStore((state) => state.nextSeq);
  const suggestForBody = useCoatStore((state) => state.suggestForBody);
  const specBasisOfBody = useCoatStore((state) => state.specBasisOfBody);
  const commissionById = useCommissionStore((state) => state.commissionById);

  const { progressOf, currentCoatText, totals } = useCoatProgress();
  const url = useFilterQuery(FILTER_KEYS);

  const [editing, setEditing] = useState<Coat | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchPaint, setBatchPaint] = useState<PaintType>('color');
  const [batchState, setBatchState] = useState<CoatState>('coated');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const activeBody = bodies.find((body) => body.id === currentBodyId) ?? bodies.find((body) => !body.returned) ?? bodies[0] ?? null;
  const bodyId = activeBody?.id ?? '';

  useEffect(() => {
    if (!currentBodyId && bodies.length > 0) setCurrentBodyId(bodies.find((body) => !body.returned)?.id ?? bodies[0]!.id);
  }, [bodies, currentBodyId, setCurrentBodyId]);

  const activeCommission = activeBody?.commissionId ? commissionById(activeBody.commissionId) ?? null : null;
  const specBasis = bodyId ? specBasisOfBody(bodyId) : null;
  const revisionStale =
    activeBody?.specRevision !== null &&
    activeCommission !== null &&
    (activeBody.specRevision ?? 0) < Math.max(...activeCommission.revisions.map((r) => r.revisionNo));

  const bodyCoats = useMemo(
    () => coats.filter((coat) => coat.bodyId === bodyId).sort((a, b) => a.seq - b.seq),
    [coats, bodyId],
  );

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const paintTypes = url.values.paintType ?? [];
    const states = url.values.state ?? [];
    return bodyCoats.filter((coat) => {
      if (keyword.length > 0) {
        const haystack = `${coat.colorName}${coat.coatDate}${coat.thicknessUm}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (paintTypes.length > 0 && !paintTypes.includes(coat.paintType)) return false;
      if (states.length > 0 && !states.includes(coat.state)) return false;
      return true;
    });
  }, [bodyCoats, url.keyword, url.values]);

  const suggestion = bodyId.length > 0 ? suggestForBody(bodyId) : null;
  const stat = bodyId.length > 0 ? progressOf(bodyId) : null;

  const openCreate = (): void => {
    if (!bodyId) {
      message.warning('请先选择或新建胎体');
      return;
    }
    setEditing(null);
    form.setFieldsValue({
      ...createEmptyCoatDraft(bodyId, nextSeq(bodyId)),
      paintType: suggestion?.paintType ?? 'raw',
      // 湿膜建议按委托最新版算；委托人改版后这里自动换成新版值（旧建议作废）
      thicknessUm: suggestion?.thicknessUm ?? 40,
    });
    setOpen(true);
  };

  const openEdit = (coat: Coat): void => {
    setEditing(coat);
    form.setFieldsValue({
      bodyId: coat.bodyId,
      seq: coat.seq,
      paintType: coat.paintType,
      colorName: coat.colorName,
      coatDate: coat.coatDate,
      thicknessUm: coat.thicknessUm,
      state: coat.state,
      needRecheck: coat.needRecheck,
      basisRevision: coat.basisRevision,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const payload: CoatDraft = { ...values };
    if (editing) {
      await updateCoat(editing.id, payload);
      message.success(`已更新第 ${payload.seq} 道工序`);
    } else {
      await createCoat(payload);
      message.success(`已新增第 ${payload.seq} 道工序`);
    }
    setOpen(false);
  };

  /** 拖拽重排：按落点重排并落库重编号 */
  const handleDrop = async (targetId: string): Promise<void> => {
    setOverId(null);
    if (!dragId || dragId === targetId || !bodyId) {
      setDragId(null);
      return;
    }
    const ids = bodyCoats.map((coat) => coat.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) {
      setDragId(null);
      return;
    }
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved as string);
    await reorderCoats(bodyId, ids);
    setDragId(null);
    message.success('道次顺序已更新并重编号');
  };

  /** 状态推进校验：前一道未完成时禁止进入下一道 */
  const handleAdvance = async (coat: Coat): Promise<void> => {
    const previous = bodyCoats.find((item) => item.seq === coat.seq - 1);
    if (previous && previous.state !== 'done') {
      message.warning(`第 ${previous.seq} 道尚未完成，禁止进入第 ${coat.seq} 道`);
      return;
    }
    await advanceState(coat.id);
  };

  const columns: ColumnsType<Coat> = [
    {
      title: '',
      dataIndex: 'drag',
      width: 44,
      render: (_value, record) => (
        <Tooltip title="按住拖动可调整道次先后">
          <span
            className="gb-drag-handle"
            draggable
            onDragStart={() => setDragId(record.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
          >
            <HolderOutlined />
          </span>
        </Tooltip>
      ),
    },
    {
      title: '道次',
      dataIndex: 'seq',
      width: 90,
      sorter: (a, b) => a.seq - b.seq,
      render: (seq: number, record) => (
        <StageTag state={record.state} seq={seq} needRecheck={record.needRecheck} />
      ),
    },
    { title: '漆种', dataIndex: 'paintType', width: 100, render: (value: PaintType) => <Tag>{PAINT_TYPE_LABEL[value]}</Tag> },
    { title: '色名', dataIndex: 'colorName', width: 110 },
    { title: '涂刷日期', dataIndex: 'coatDate', width: 120, sorter: (a, b) => a.coatDate.localeCompare(b.coatDate) },
    {
      title: '湿膜厚度',
      dataIndex: 'thicknessUm',
      width: 110,
      render: (value: number, record) => {
        // 依据版本落后于委托最新版时，旧道次厚度按旧版保留，标「旧版建议」
        const stale = record.basisRevision !== null && activeCommission !== null
          && record.basisRevision < Math.max(...activeCommission.revisions.map((r) => r.revisionNo));
        return (
          <Space size={2} wrap>
            <span>{value} μm</span>
            {stale ? (
              <Tooltip title="该道按旧版委托的湿膜建议施工并保留；新建议按新版重算">
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>旧版建议</Tag>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '依据版本',
      dataIndex: 'basisRevision',
      width: 120,
      render: (value: number | null) =>
        value === null ? <Typography.Text type="secondary">无单</Typography.Text> : <Tag color="geekblue">第 {value} 版</Tag>,
    },
    {
      title: '状态',
      key: 'state',
      width: 150,
      render: (_value, record) =>
        record.returned ? (
          <Tooltip title="未开工 / 未涂道次：撤单或改版选择退回重排时标退，保留痕迹可重新启用">
            <Tag color="default">退回</Tag>
          </Tooltip>
        ) : (
          <StageTag state={record.state} needRecheck={record.needRecheck} />
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      render: (_value, record) =>
        record.returned ? (
          <Space size={4} wrap>
            <Popconfirm
              title="重新启用该道次"
              description="清除退回标记，按当前委托最新版本重新纳入排产。"
              okText="确认"
              cancelText="取消"
              onConfirm={() =>
                void restoreReturned(record.id, { state: 'todo', coatDate: '' }).then(() =>
                  message.success('该道次已按最新委托版本重新纳入排产'),
                )
              }
            >
              <Button size="small" type="link" icon={<RedoOutlined />}>
                重新排产
              </Button>
            </Popconfirm>
            <Popconfirm
              title="彻底删除该道次"
              description="退回道次的删除操作，删除后其余道次重编号。"
              okText="确认"
              cancelText="取消"
              onConfirm={() => void removeCoat(record.id).then(() => message.success('已删除该道次'))}
            >
              <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ) : (
          <Space size={4} wrap>
            <Button size="small" type="link" onClick={() => void handleAdvance(record)}>
              推进状态
            </Button>
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Popconfirm
              title="删除该道次"
              description="删除后其余道次会自动重编号。"
              okText="确认"
              cancelText="取消"
              onConfirm={() => void removeCoat(record.id).then(() => message.success('已删除该道次'))}
            >
              <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>髹涂道次编排</h2>
          <p>逐道登记漆种与色名，拖拽调整先后顺序；批量改漆种或状态，同器型自动带出上次做法。</p>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 220 }}
            placeholder="选择胎体"
            value={bodyId || undefined}
            options={bodies.map((body) => ({
              value: body.id,
              label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
            }))}
            onChange={(value: string) => setCurrentBodyId(value)}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增道次
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="道次总数" value={stat?.coatTotal ?? 0} suffix="道" tone="primary" />
        <StatBadge label="完成率" value={`${stat?.coatPercent ?? 0}%`} percent={stat?.coatPercent ?? 0} tone="success" />
        <StatBadge label="当前道次" value={stat?.currentSeq ? `第 ${stat.currentSeq} 道` : '已完工'} tone="warning" />
        <StatBadge label="全局待复检" value={totals.recheck} suffix="道" tone="danger" />
        <StatBadge label="退回道次" value={bodyCoats.filter((coat) => coat.returned).length} suffix="道" tone="info" />
      </div>

      {activeBody ? (
        <Alert
          style={{ marginBottom: 14 }}
          type={activeBody.reconStatus === 'held' ? 'error' : activeBody.returned ? 'warning' : 'info'}
          showIcon
          message={
            <Space wrap size={8}>
              <Tag color="#8c2f1f">{activeBody.code}</Tag>
              {activeCommission ? (
                <>
                  <Tag color={COMMISSION_STATUS_COLOR[activeCommission.status]}>
                    {activeCommission.code} · {COMMISSION_STATUS_LABEL[activeCommission.status]}
                  </Tag>
                  <span>
                    委托人 {activeCommission.clientName} · 交期 {activeCommission.dueDate || '未定'}
                  </span>
                  <Tag color="geekblue">
                    当前认第 {activeBody.specRevision ?? 1} 版 / 委托第 {activeCommission.revisions.length} 版
                  </Tag>
                </>
              ) : (
                <Tag color={RECON_STATUS_COLOR[activeBody.reconStatus]}>{RECON_STATUS_LABEL[activeBody.reconStatus]}</Tag>
              )}
              {activeBody.returned ? <Tag color="default">该胎体已退回排产</Tag> : null}
              {activeBody.reconStatus === 'held' ? <Typography.Text strong>对不上号，已挂起，等前台判单</Typography.Text> : null}
            </Space>
          }
          description={
            specBasis ? (
              <Space wrap size={14}>
                <span>
                  认单规格：{BODY_SHAPE_LABEL[specBasis.shape]} · {specBasis.sizeMm}mm
                  {specBasis.revisionNo !== null ? `（依据第 ${specBasis.revisionNo} 版）` : '（无单）'}
                </span>
                <Tag color="gold">建议湿膜 {specBasis.thicknessUm} μm</Tag>
                <Tag color="blue">建议荫干 {suggestion?.dryingHours ?? '-'} 小时</Tag>
                {revisionStale && activeBody.specPolicy ? (
                  <Tag color={activeBody.specPolicy === 'finishOld' ? 'orange' : 'purple'}>
                    已开工件：{CHANGE_POLICY_LABEL[activeBody.specPolicy]}
                  </Tag>
                ) : null}
                {revisionStale ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    委托人改版后，湿膜厚度建议与荫干时长已按新版作废重算；
                    {activeBody.specPolicy === 'finishOld'
                      ? '旧道次照旧做完，道次表标「旧版建议」并写明依据版本。'
                      : '本件退回重排：未涂道次标「退回」，可重新排产。'}
                  </Typography.Text>
                ) : null}
              </Space>
            ) : null
          }
        />
      ) : null}

      {suggestion && suggestion.sourceCode ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message={`同器型参考：${suggestion.sourceCode} 上次采用${suggestion.sourceColor || '同漆种'}，建议下一道用「${
            PAINT_TYPE_LABEL[suggestion.paintType]
          }」，间隔约 ${suggestion.intervalHours} 小时`}
          action={
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => {
                form.setFieldsValue({ paintType: suggestion.paintType });
                message.success('已带出建议漆种');
              }}
            >
              带出建议
            </Button>
          }
        />
      ) : null}

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={url.reset}
        keywordPlaceholder="搜索色名 / 日期 / 厚度…"
        actions={
          <Space size={6} wrap>
            <Select
              size="small"
              style={{ width: 120 }}
              value={batchPaint}
              options={[...PAINT_TYPE_OPTIONS]}
              onChange={(value: PaintType) => setBatchPaint(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() =>
                void batchUpdate(selectedIds, { paintType: batchPaint }).then(() => {
                  message.success(`已批量改为${PAINT_TYPE_LABEL[batchPaint]}`);
                  setSelectedIds([]);
                })
              }
            >
              批量改漆种
            </Button>
            <Select
              size="small"
              style={{ width: 120 }}
              value={batchState}
              options={[...COAT_STATE_OPTIONS]}
              onChange={(value: CoatState) => setBatchState(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() =>
                void batchUpdate(selectedIds, { state: batchState }).then(() => {
                  message.success(`已批量改为${COAT_STATE_LABEL[batchState]}`);
                  setSelectedIds([]);
                })
              }
            >
              批量改状态
            </Button>
          </Space>
        }
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={bodyCoats.length === 0 ? '该胎体尚未编排髹涂道次' : '当前筛选条件下没有道次'}
            description={
              bodyCoats.length === 0
                ? '从第一道生漆打底开始，逐道登记漆种、色名与湿膜厚度。'
                : '试着调整漆种或状态筛选条件。'
            }
            actionText="新增道次"
            onAction={openCreate}
            secondaryText="重置筛选"
            onSecondary={url.reset}
            size="small"
          />
        ) : (
          <Table<Coat>
            rowKey="id"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={filtered}
            onRow={(record) => ({
              onDragOver: (event) => {
                if (record.returned) return;
                event.preventDefault();
                setOverId(record.id);
              },
              onDrop: () => void handleDrop(record.id),
              className: overId === record.id && dragId !== record.id
                ? 'gb-row-drop-target'
                : record.returned
                  ? 'gb-row-returned'
                  : undefined,
            })}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
            }}
            rowClassName={(record) => (record.id === dragId ? 'gb-row-dragging' : '')}
          />
        )}
      </Card>

      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
        当前胎体进度：{bodyId ? currentCoatText(bodyId) : '未选择胎体'}
      </Typography.Text>

      <Modal
        open={open}
        title={editing ? `编辑第 ${editing.seq} 道` : '新增髹涂道次'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="seq" label="道次序号" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={99} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="paintType" label="漆种" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...PAINT_TYPE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="colorName" label="色名" rules={[{ required: true, message: '请填写色名' }]} style={{ flex: 1 }}>
              <Select
                showSearch
                options={COLOR_NAME_OPTIONS.map((name) => ({ value: name, label: name }))}
                placeholder="如：朱红"
              />
            </Form.Item>
            <Form.Item name="coatDate" label="涂刷日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="thicknessUm" label="湿膜厚度（μm）" rules={[{ required: true }]} style={{ flex: 1 }}
              extra={suggestion ? `按当前委托版本建议 ${suggestion.thicknessUm} μm（改版后自动重算）` : undefined}>
              <InputNumber min={5} max={500} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="state" label="状态" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...COAT_STATE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Form.Item name="needRecheck" label="待复检">
            <Select
              options={[
                { value: false, label: '正常' },
                { value: true, label: '待复检（荫房异常）' },
              ]}
            />
          </Form.Item>
          <Form.Item name="basisRevision" label="依据委托版本">
            <Select
              disabled
              options={
                activeCommission
                  ? activeCommission.revisions.map((revision) => ({
                      value: revision.revisionNo,
                      label: `第 ${revision.revisionNo} 版 · ${BODY_SHAPE_LABEL[revision.shape]} / ${revision.sizeMm}mm`,
                    }))
                  : ([{ value: -1, label: '无单胎体' }] as Array<{ value: number; label: string }>)
              }
            />
          </Form.Item>
          <Alert
            type="warning"
            showIcon
            message={`环境适宜时，${PAINT_TYPE_LABEL[form.getFieldValue('paintType') as PaintType] ?? '该漆种'}建议间隔约 ${
              suggestion?.intervalHours ?? suggestIntervalHours('raw')
            } 小时再进入下一道；按当前认到的委托版本，湿膜建议 ${suggestion?.thicknessUm ?? 40} μm、预计荫干 ${
              suggestion?.dryingHours ?? '-'
            } 小时。`}
          />
          {revisionStale && activeBody?.specPolicy ? (
            <Alert
              style={{ marginTop: 8 }}
              type={activeBody.specPolicy === 'finishOld' ? 'info' : 'error'}
              showIcon
              message={
                activeBody.specPolicy === 'finishOld'
                  ? '本件选择「照旧做完」：已落道次保留旧版依据，后续新道次按新版建议施工。'
                  : '本件选择「退回重排」：未涂道次已标「退回」，已涂道次留存；点「重新排产」按新版重铺。'
              }
            />
          ) : null}
        </Form>
      </Modal>
    </div>
  );
}
