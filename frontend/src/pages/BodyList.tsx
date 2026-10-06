/**
 * /bodies 胎体与器型台账
 * 新建胎体、按材质与器型筛选（筛选条件同步 URL query），卡片回显道次完成度与最近荫房记录。
 * 消费 Body、Coat、Room；复用 <StageTag>、<EmptyPanel> 与 <StatBadge>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, RightCircleOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import StageTag from '@/components/common/StageTag';
import { useCoatProgress } from '@/hooks/useCoatProgress';
import { ROUTES } from '@/router';
import { DEFAULT_BODY_FILTERS, selectFilteredBodies, useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useCommissionStore } from '@/stores/commissionStore';
import {
  BODY_MATERIAL_LABEL,
  BODY_MATERIAL_OPTIONS,
  BODY_SHAPE_LABEL,
  BODY_SHAPE_OPTIONS,
  BODY_STATE_OPTIONS,
  RECON_STATUS_COLOR,
  RECON_STATUS_LABEL,
  createEmptyBodyDraft,
  type Body,
  type BodyDraft,
  type BodyMaterial,
  type BodyShape,
} from '@/types/body';

/** 模块级常量：保证 useFilterQuery 的 keys 引用稳定 */
const FILTER_KEYS = ['material', 'shape'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'material', label: '材质', options: BODY_MATERIAL_OPTIONS },
  { key: 'shape', label: '器型', options: BODY_SHAPE_OPTIONS },
];

export default function BodyList() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<BodyDraft>();

  const bodies = useBodyStore((state) => state.bodies);
  const filters = useBodyStore((state) => state.filters);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const createBody = useBodyStore((state) => state.createBody);
  const updateBody = useBodyStore((state) => state.updateBody);
  const removeBody = useBodyStore((state) => state.removeBody);
  const advanceBodyState = useBodyStore((state) => state.advanceBodyState);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const setKeyword = useBodyStore((state) => state.setKeyword);
  const setMaterials = useBodyStore((state) => state.setMaterials);
  const setShapes = useBodyStore((state) => state.setShapes);

  const { progressOf, currentCoatText, totals } = useCoatProgress();
  const coats = useCoatStore((state) => state.coats);
  const commissionById = useCommissionStore((state) => state.commissionById);

  const url = useFilterQuery(FILTER_KEYS);
  const [editing, setEditing] = useState<Body | null>(null);
  const [open, setOpen] = useState(false);

  // URL query → store 筛选条件（URL 为唯一事实来源）
  useEffect(() => {
    setKeyword(url.keyword);
    setMaterials(url.values.material as BodyMaterial[]);
    setShapes(url.values.shape as BodyShape[]);
  }, [url.keyword, url.values, setKeyword, setMaterials, setShapes]);

  const filtered = useMemo(() => selectFilteredBodies(bodies, filters), [bodies, filters]);
  const activeFiltered = useMemo(() => filtered.filter((body) => !body.returned), [filtered]);
  const returnedFiltered = useMemo(() => filtered.filter((body) => body.returned), [filtered]);
  const heldCount = bodies.filter((body) => body.reconStatus === 'held' && !body.returned).length;

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue(createEmptyBodyDraft());
    setOpen(true);
  };

  const openEdit = (body: Body): void => {
    setEditing(body);
    form.setFieldsValue({
      code: body.code,
      material: body.material,
      shape: body.shape,
      sizeMm: body.sizeMm,
      ownerName: body.ownerName,
      state: body.state,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (editing) {
      await updateBody(editing.id, values);
      message.success(`已更新胎体 ${values.code}`);
    } else {
      const created = await createBody(values);
      message.success(`已新建胎体 ${created.code}，可进入道次编排`);
    }
    setOpen(false);
  };

  const handleRemove = async (body: Body): Promise<void> => {
    await removeBody(body.id);
    message.success(`已删除胎体 ${body.code} 及其关联记录`);
  };

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>胎体与器型台账</h2>
          <p>登记胎骨材质、器型与尺寸；卡片回显道次完成度、当前道次与最近一次荫房判定。</p>
        </div>
        <Space>
          <Button onClick={() => navigate(ROUTES.desk)}>前往接单前台</Button>
          <Button onClick={() => navigate(ROUTES.coats)}>前往道次编排</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建胎体
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="胎体总数" value={bodies.length} suffix="件" tone="primary" />
        <StatBadge label="道次完成率" value={`${totals.percent}%`} percent={totals.percent} tone="success" />
        <StatBadge label="挂起待判" value={heldCount} suffix="件" tone="danger" />
        <StatBadge label="待复检道次" value={totals.recheck} suffix="道" tone="warning" />
        <StatBadge label="已退回" value={bodies.filter((b) => b.returned).length} suffix="件" tone="info" />
      </div>

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={() => {
          url.reset();
          setKeyword(DEFAULT_BODY_FILTERS.keyword);
        }}
        keywordPlaceholder="搜索编号 / 藏家 / 尺寸…"
        actions={<Typography.Text type="secondary">共 {filtered.length} / {bodies.length} 件</Typography.Text>}
      />

      <div style={{ marginTop: 16 }}>
        {activeFiltered.length === 0 ? (
          <EmptyPanel
            title={bodies.filter((b) => !b.returned).length === 0 ? '还没有登记在制胎体' : '当前筛选条件下没有胎体'}
            description={
              bodies.filter((b) => !b.returned).length === 0
                ? '先在接单前台登记委托单，或直接登记一件胎体（无单胎体会单列），再逐道编排髹涂工序。'
                : '试着放宽材质或器型条件，或重置筛选。'
            }
            actionText="新建胎体"
            onAction={openCreate}
            secondaryText={bodies.length === 0 ? undefined : '去接单前台'}
            onSecondary={() => navigate(ROUTES.desk)}
          />
        ) : (
          <Row gutter={[16, 16]}>
            {activeFiltered.map((body) => {
              const stat = progressOf(body.id);
              const recheck = coats.some((coat) => coat.bodyId === body.id && coat.needRecheck);
              const commission = body.commissionId ? commissionById(body.commissionId) : undefined;
              return (
                <Col key={body.id} xs={24} md={12} xl={8}>
                  <Card
                    className={`gb-body-card${currentBodyId === body.id ? ' is-active' : ''}`}
                    title={
                      <Space size={6} wrap>
                        <Tag color="#8c2f1f">{body.code}</Tag>
                        <StageTag state={body.state} needRecheck={recheck} />
                        {body.reconStatus !== 'linked' ? (
                          <Tag color={RECON_STATUS_COLOR[body.reconStatus]}>{RECON_STATUS_LABEL[body.reconStatus]}</Tag>
                        ) : null}
                      </Space>
                    }
                    extra={
                      <Button
                        type="link"
                        size="small"
                        icon={<RightCircleOutlined />}
                        onClick={() => {
                          setCurrentBodyId(body.id);
                          navigate(ROUTES.coats);
                        }}
                      >
                        道次
                      </Button>
                    }
                    onClick={() => setCurrentBodyId(body.id)}
                  >
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <Space size={6} wrap>
                        <Tag>{BODY_MATERIAL_LABEL[body.material]}</Tag>
                        <Tag>{BODY_SHAPE_LABEL[body.shape]}</Tag>
                        <Tag color="gold">{body.sizeMm} mm</Tag>
                      </Space>
                      <Typography.Text type="secondary">
                        认单：
                        {commission ? (
                          <Tag color="geekblue" style={{ marginInlineStart: 4 }}>
                            {commission.code} · v{body.specRevision ?? 1}
                          </Tag>
                        ) : (
                          <Tag style={{ marginInlineStart: 4 }}>无单</Tag>
                        )}
                        委托人：{commission?.clientName ?? (body.ownerName || '未填写')}
                      </Typography.Text>
                      {body.reconStatus === 'held' ? (
                        <Typography.Text type="danger" style={{ fontSize: 12 }}>
                          挂起原因：{body.reconNote || '两边对不上号，等人工判定'}
                        </Typography.Text>
                      ) : null}
                      <Typography.Text>
                        道次完成 <strong>{stat.coatDone}</strong> / {stat.coatTotal}（{stat.coatPercent}%）
                        {stat.currentSeq > 0 ? ` · 当前第 ${stat.currentSeq} 道` : ' · 全部完成'}
                      </Typography.Text>
                      <Typography.Text type="secondary">当前工序：{currentCoatText(body.id)}</Typography.Text>
                      <Typography.Text type="secondary">最近荫房：{stat.lastRoomVerdict}</Typography.Text>
                      <Typography.Text type="secondary">
                        荫干等待 {stat.dryingHours} 小时 · 荫房超标 {stat.roomOverCount} 次
                      </Typography.Text>
                      <Space size={4} wrap onClick={(event) => event.stopPropagation()}>
                        <Tooltip title="按 待髹涂 → 髹涂中 → 待荫干 → 已完成 推进">
                          <Button size="small" onClick={() => void advanceBodyState(body.id)}>
                            推进状态
                          </Button>
                        </Tooltip>
                        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(body)}>
                          编辑
                        </Button>
                        <Popconfirm
                          title="删除胎体"
                          description="将同时删除其道次、荫房、打磨、镶嵌与质检记录，不可恢复。"
                          okText="确认删除"
                          cancelText="取消"
                          onConfirm={() => void handleRemove(body)}
                        >
                          <Button size="small" danger icon={<DeleteOutlined />}>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    </Space>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}

        {returnedFiltered.length > 0 ? (
          <div style={{ marginTop: 22 }}>
            <Typography.Title level={5} style={{ color: 'rgba(42,28,22,0.55)' }}>
              已退回排产（撤单未开工 / 改版退回重排）· {returnedFiltered.length} 件
            </Typography.Title>
            <Row gutter={[16, 16]}>
              {returnedFiltered.map((body) => (
                <Col key={body.id} xs={24} md={12} xl={8}>
                  <Card size="small" style={{ opacity: 0.75 }}>
                    <Space direction="vertical" size={4}>
                      <Space size={6} wrap>
                        <Tag color="#8c2f1f">{body.code}</Tag>
                        <Tag>{BODY_SHAPE_LABEL[body.shape]} · {body.sizeMm}mm</Tag>
                        <Tag color="default">已退回</Tag>
                      </Space>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{body.reconNote || '委托撤单 / 改版后退回'}</Typography.Text>
                    </Space>
                  </Card>
                </Col>
              ))}
            </Row>
          </div>
        ) : null}
      </div>

      <Modal
        open={open}
        title={editing ? `编辑胎体 ${editing.code}` : '新建胎体'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="code" label="胎体编号" rules={[{ required: true, message: '请输入编号，如 LQ-2404' }]}>
            <Input placeholder="LQ-2404" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="material" label="材质" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...BODY_MATERIAL_OPTIONS]} />
            </Form.Item>
            <Form.Item name="shape" label="器型" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...BODY_SHAPE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="sizeMm" label="主要尺寸（mm）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={10} max={2000} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="state" label="状态" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...BODY_STATE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Form.Item name="ownerName" label="委托 / 藏家">
            <Input placeholder="如：市工艺美术馆" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
