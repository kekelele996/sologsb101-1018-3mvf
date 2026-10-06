/**
 * /desk 接单前台
 * 前台与工序台各记各的：本页只管委托单（委托人、器型、尺寸、交期），
 * 并按编号与工序台胎体对账 —— 对不上先挂起等人判。
 * 消费 Commission、Body、Coat；复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RightCircleOutlined,
  StopOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useCommissionStore } from '@/stores/commissionStore';
import { reconcile, HELD_REASON_LABEL, type HeldItem } from '@/utils/reconcile';
import { ROUTES } from '@/router';
import { BODY_MATERIAL_LABEL, BODY_MATERIAL_OPTIONS, BODY_SHAPE_LABEL, BODY_SHAPE_OPTIONS, RECON_STATUS_COLOR, type Body as BodyRecord } from '@/types/body';
import {
  CHANGE_POLICY_LABEL,
  CHANGE_POLICY_OPTIONS,
  COMMISSION_STATUS_COLOR,
  COMMISSION_STATUS_LABEL,
  COMMISSION_STATUS_OPTIONS,
  daysUntilDue,
  latestRevision,
  type ChangePolicy,
  type Commission,
  type CommissionDraft,
} from '@/types/commission';

export default function FrontDesk() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CommissionDraft>();
  const [reviseForm] = Form.useForm<{ shape: Commission['revisions'][number]['shape']; sizeMm: number; note: string; policy: ChangePolicy }>();

  const commissions = useCommissionStore((state) => state.commissions);
  const loadCommissions = useCommissionStore((state) => state.loadCommissions);
  const createCommission = useCommissionStore((state) => state.createCommission);
  const updateCommissionInfo = useCommissionStore((state) => state.updateCommissionInfo);
  const reviseCommission = useCommissionStore((state) => state.reviseCommission);
  const cancelCommission = useCommissionStore((state) => state.cancelCommission);
  const completeCommission = useCommissionStore((state) => state.completeCommission);
  const removeCommission = useCommissionStore((state) => state.removeCommission);
  const bindBody = useCommissionStore((state) => state.bindBody);
  const unbindBody = useCommissionStore((state) => state.unbindBody);
  const resolveHeld = useCommissionStore((state) => state.resolveHeld);
  const recomputeReconcile = useCommissionStore((state) => state.recomputeReconcile);

  const bodies = useBodyStore((state) => state.bodies);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const coats = useCoatStore((state) => state.coats);

  const [tab, setTab] = useState('orders');
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Commission | null>(null);
  const [revising, setRevising] = useState<Commission | null>(null);
  const [cancelling, setCancelling] = useState<Commission | null>(null);
  const [cancelNote, setCancelNote] = useState('');
  const [bindingBody, setBindingBody] = useState<string | null>(null);
  const [bindCommissionId, setBindCommissionId] = useState<string | undefined>();
  const [resolving, setResolving] = useState<HeldItem | null>(null);
  const [resolveChoice, setResolveChoice] = useState<'relink' | 'unlink'>('relink');

  // 切到本页时重新拉一次并对账，保证前台 / 工序台两边刚写的数据都在
  useEffect(() => {
    void (async () => {
      await Promise.all([loadCommissions()]);
      await recomputeReconcile();
    })();
  }, [loadCommissions, recomputeReconcile]);

  const result = useMemo(() => reconcile(bodies, commissions), [bodies, commissions]);
  const bodyRecordById = useMemo(() => new Map(bodies.map((bodyItem) => [bodyItem.id, bodyItem])), [bodies]);

  const boundMap = useMemo(() => {
    const map = new Map<string, BodyRecord & { coatDone: number; coatTotal: number }>();
    bodies.forEach((bodyItem) => {
      if (bodyItem.commissionId && !bodyItem.returned) {
        const bodyCoats = coats.filter((coat) => coat.bodyId === bodyItem.id);
        map.set(bodyItem.commissionId, {
          ...bodyItem,
          coatDone: bodyCoats.filter((coat) => coat.state === 'done').length,
          coatTotal: bodyCoats.length,
        });
      }
    });
    return map;
  }, [bodies, coats]);

  const filteredOrders = useMemo(() => {
    const word = keyword.trim();
    return commissions.filter((commission) => {
      if (statusFilter.length > 0 && !statusFilter.includes(commission.status)) return false;
      if (word.length > 0) {
        const latest = latestRevision(commission);
        const haystack = `${commission.code}${commission.clientName}${commission.contact}${latest ? latest.sizeMm : ''}`;
        if (!haystack.includes(word)) return false;
      }
      return true;
    });
  }, [commissions, keyword, statusFilter]);

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue({
      code: `WT-${String(new Date().getFullYear()).slice(2)}${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(commissions.length + 1).padStart(2, '0')}`,
      clientName: '',
      contact: '',
      material: 'wood',
      dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      shape: 'bowl',
      sizeMm: 120,
      revisionNote: '',
    });
    setOpen(true);
  };

  const openEdit = (commission: Commission): void => {
    setEditing(commission);
    const latest = latestRevision(commission);
    form.setFieldsValue({
      code: commission.code,
      clientName: commission.clientName,
      contact: commission.contact,
      material: commission.material,
      dueDate: commission.dueDate,
      shape: latest?.shape ?? 'bowl',
      sizeMm: latest?.sizeMm ?? 120,
      revisionNote: '',
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (editing) {
      const latest = latestRevision(editing);
      const specChanged = latest && (latest.shape !== values.shape || latest.sizeMm !== values.sizeMm);
      // 基础信息与规格分开走：改器型 / 尺寸必须走「改尺寸器型」入口，避免悄悄改版
      await updateCommissionInfo(editing.id, {
        clientName: values.clientName,
        contact: values.contact,
        material: values.material,
        dueDate: values.dueDate,
      });
      if (specChanged) {
        message.warning('委托人 / 交期已保存；器型或尺寸有改动，请用「改尺寸器型」按钮登记新版本');
      } else {
        message.success(`已更新委托单 ${values.code}`);
      }
    } else {
      try {
        const created = await createCommission(values);
        message.success(`前台已登记委托单 ${created.code}，可等待工序台认单`);
      } catch (error) {
        message.error(`委托单写入失败（已只重试前台写入）：${error instanceof Error ? error.message : '未知错误'}`);
      }
    }
    setOpen(false);
  };

  const openRevise = (commission: Commission): void => {
    const latest = latestRevision(commission);
    setRevising(commission);
    reviseForm.setFieldsValue({ sizeMm: latest?.sizeMm ?? 120, note: '', policy: 'finishOld' });
  };

  const submitRevise = async (): Promise<void> => {
    if (!revising) return;
    const latest = latestRevision(revising);
    const values = await reviseForm.validateFields();
    if (latest && latest.shape === values.shape && latest.sizeMm === values.sizeMm) {
      message.warning('器型与尺寸都没变，不用开新版本');
      return;
    }
    await reviseCommission(
      revising.id,
      { shape: values.shape, sizeMm: values.sizeMm, note: values.note || '委托人中途改尺寸 / 器型' },
      values.policy,
    );
    message.success(
      values.policy === 'finishOld'
        ? '已登记新版本：湿膜与荫干建议按新版重算，已开工件照旧做完（道次页写明依据版本）'
        : '已登记新版本并退回重排：未涂道次标退回，已涂道次留存',
    );
    setRevising(null);
  };

  const submitCancel = async (): Promise<void> => {
    if (!cancelling) return;
    await cancelCommission(cancelling.id, cancelNote || '委托人撤单');
    message.success('委托单已撤：未开工件已退回，已髹涂件留存');
    setCancelling(null);
    setCancelNote('');
  };

  const openBind = (commissionId: string): void => {
    setBindingBody('');
    setBindCommissionId(commissionId);
  };

  const submitBind = async (): Promise<void> => {
    if (!bindingBody || !bindCommissionId) return;
    await bindBody(bindingBody, bindCommissionId);
    message.success('胎体已认单，对账状态已更新');
    setBindingBody(null);
    setBindCommissionId(undefined);
  };

  const dueTag = (commission: Commission) => {
    if (commission.status !== 'active' || !commission.dueDate) return null;
    const days = daysUntilDue(commission.dueDate);
    if (Number.isNaN(days)) return null;
    if (days < 0) return <Tag color="error">逾期 {-days} 天</Tag>;
    if (days <= 7) return <Tag color="warning">剩 {days} 天</Tag>;
    return <Tag color="success">剩 {days} 天</Tag>;
  };

  const orderColumns: ColumnsType<Commission> = [
    { title: '委托单号', dataIndex: 'code', width: 120, render: (value: string) => <Tag color="#8c2f1f">{value}</Tag> },
    { title: '委托人', dataIndex: 'clientName', width: 110 },
    {
      title: '器型 / 尺寸',
      key: 'spec',
      width: 150,
      render: (_v, record) => {
        const latest = latestRevision(record);
        const revCount = record.revisions.length;
        return (
          <Space size={4} wrap>
            <Tag>{latest ? BODY_SHAPE_LABEL[latest.shape] : '-'}</Tag>
            <span>{latest?.sizeMm}mm</span>
            {revCount > 1 ? <Tag color="orange">v{revCount} 改版</Tag> : null}
          </Space>
        );
      },
    },
    { title: '材质', dataIndex: 'material', width: 90, render: (value: Commission['material']) => BODY_MATERIAL_LABEL[value] },
    { title: '交期', dataIndex: 'dueDate', width: 150, render: (value: string, record) => (
      <Space size={4}>{value || '未定'}{dueTag(record)}</Space>
    ) },
    {
      title: '工序台认单',
      key: 'bound',
      width: 150,
      render: (_v, record) => {
        const bound = boundMap.get(record.id);
        if (record.status === 'cancelled') {
          return <Typography.Text type="secondary">撤单（已涂留存）</Typography.Text>;
        }
        if (!bound) return <Tag>有单无胎</Tag>;
        return (
          <Space size={4}>
            <Tag color={RECON_STATUS_COLOR[bound.reconStatus]}>{bound.code}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {bound.coatDone}/{bound.coatTotal} 道
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: Commission['status']) => (
        <Tag color={COMMISSION_STATUS_COLOR[value]}>{COMMISSION_STATUS_LABEL[value]}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 300,
      render: (_v, record) => {
        const bound = boundMap.get(record.id);
        return (
          <Space size={2} wrap>
            {record.status === 'active' ? (
              <>
                <Tooltip title="委托人中途改器型 / 尺寸：开新版本，建议作废重算">
                  <Button size="small" type="link" icon={<SwapOutlined />} onClick={() => openRevise(record)}>
                    改尺寸器型
                  </Button>
                </Tooltip>
                <Button size="small" type="link" icon={<StopOutlined />} danger onClick={() => { setCancelling(record); setCancelNote(''); }}>
                  撤单
                </Button>
              </>
            ) : null}
            {bound ? (
              <Button
                size="small"
                type="link"
                icon={<RightCircleOutlined />}
                onClick={() => {
                  setCurrentBodyId(bound.id);
                  navigate(ROUTES.coats);
                }}
              >
                看道次
              </Button>
            ) : record.status === 'active' ? (
              <Button size="small" type="link" onClick={() => openBind(record.id)}>
                认单到胎体
              </Button>
            ) : null}
            {record.status === 'active' ? (
              <Button size="small" type="link" onClick={() => void completeCommission(record.id).then(() => message.success('委托已标记完成'))}>
                完成
              </Button>
            ) : null}
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
              编辑
            </Button>
            {!bound ? (
              <Popconfirm
                title="删除委托单"
                description="仅删除前台这一份台账；没有胎体认单才可删。"
                okText="确认删除"
                cancelText="取消"
                onConfirm={() => void removeCommission(record.id).then(() => message.success('已删除委托单')).catch((error: unknown) => message.error(error instanceof Error ? error.message : '删除失败'))}
              >
                <Button size="small" type="link" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ) : null}
          </Space>
        );
      },
    },
  ];

  const heldColumns: ColumnsType<HeldItem> = [
    {
      title: '胎体',
      dataIndex: ['body', 'code'],
      width: 120,
      render: (_v, record) => <Tag color="#8c2f1f">{record.body.code}</Tag>,
    },
    {
      title: '挂起原因',
      dataIndex: 'reason',
      width: 110,
      render: (value: HeldItem['reason']) => <Tag color="error">{HELD_REASON_LABEL[value]}</Tag>,
    },
    {
      title: '认到的委托单',
      key: 'commission',
      width: 180,
      render: (_v, record) =>
        record.commission ? (
          <Space direction="vertical" size={0}>
            <Space size={4}>
              <Tag color="gold">{record.commission.code}</Tag>
              <span>{record.commission.clientName}</span>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              胎体依据第 {record.body.specRevision ?? '?'} 版 · 委托已到第 {record.commission.revisions.length} 版
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">查无此单</Typography.Text>
        ),
    },
    { title: '对账说明', dataIndex: 'detail' },
    {
      title: '人工判定',
      key: 'action',
      width: 230,
      render: (_v, record) => (
        <Space size={4} wrap>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<AuditOutlined />}
            onClick={() => {
              setResolving(record);
              setResolveChoice(record.commission ? 'relink' : 'unlink');
            }}
          >
            判单
          </Button>
          <Popconfirm
            title="判为无单胎体"
            description="解绑后该胎体进入「无单单列」。"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void unbindBody(record.body.id, '人工判定：与委托单无关').then(() => message.success('已移入无单单列'))}
          >
            <Button size="small">判无单</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const unlinkedColumns: ColumnsType<BodyRecord> = [
    { title: '胎体编号', dataIndex: 'code', width: 120, render: (value: string) => <Tag color="#8c2f1f">{value}</Tag> },
    { title: '记的委托人', dataIndex: 'ownerName', width: 140, render: (value: string) => value || '（空）' },
    {
      title: '器型 / 尺寸',
      key: 'spec',
      width: 160,
      render: (_v, record) => (
        <Space size={4}>
          <Tag>{BODY_SHAPE_LABEL[record.shape]}</Tag>
          <span>{record.sizeMm}mm</span>
          <Tag>{BODY_MATERIAL_LABEL[record.material]}</Tag>
        </Space>
      ),
    },
    { title: '备注', dataIndex: 'reconNote' },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_v, record) => (
        <Space size={4} wrap>
          <Button size="small" type="primary" ghost onClick={() => { setBindingBody(record.id); setBindCommissionId(undefined); }}>
            认一张委托单
          </Button>
          <Button
            size="small"
            onClick={() => {
              setCurrentBodyId(record.id);
              navigate(ROUTES.bodies);
            }}
          >
            去胎体页
          </Button>
        </Space>
      ),
    },
  ];

  const retainedBodies = result.retained;
  const bindableCommissions = commissions.filter(
    (commission) =>
      commission.status === 'active' &&
      !bodies.some((body) => body.commissionId === commission.id && !body.returned),
  );
  const bindableBodies = bodies.filter(
    (body) => !body.commissionId || (bindingBody === body.id),
  );

  const activeCount = commissions.filter((c) => c.status === 'active').length;

  const ordersTab = (
    <div>
      <Card
        styles={{ body: { padding: 0 } }}
        title={
          <Space>
            <span>委托单台账（前台自留）</span>
            <Badge count={result.unbound.length} color="#c9963c" title="有单无胎" />
            <Badge count={result.held.length} color="#b03a2e" title="挂起待判" />
          </Space>
        }
        extra={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="搜单号 / 委托人 / 尺寸"
              style={{ width: 220 }}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Select
              mode="multiple"
              allowClear
              size="middle"
              style={{ minWidth: 160 }}
              placeholder="状态"
              value={statusFilter}
              options={[...COMMISSION_STATUS_OPTIONS]}
              onChange={setStatusFilter}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              登记委托单
            </Button>
          </Space>
        }
      >
        {filteredOrders.length === 0 ? (
          <EmptyPanel
            title={commissions.length === 0 ? '前台还没有委托单' : '当前条件下没有委托单'}
            description="前台只记委托人、器型、尺寸与交期；工序台认单后两边按编号对账。"
            actionText="登记委托单"
            onAction={openCreate}
            size="small"
          />
        ) : (
          <Table<Commission> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={orderColumns} dataSource={filteredOrders} />
        )}
      </Card>

      <Alert
        style={{ marginTop: 14 }}
        type="info"
        showIcon
        message="两边各记各的，按编号对账"
        description="委托单撤掉后：没开工的胎体退回排产；已髹涂的件留着。委托人改器型/尺寸会开新版本，湿膜厚度与荫干时长建议按新版作废重算；已开工件照旧做完或退回重排，由登记人逐件选定，道次页上两种处置看得出来。"
      />
    </div>
  );

  const reconcileTab = (
    <Row gutter={[16, 16]}>
      <Col span={24}>
        <Card size="small" title={<Space><Tag color="error">挂起待判</Tag><Badge count={result.held.length} color="#b03a2e" /></Space>}>
          {result.held.length === 0 ? (
            <Typography.Text type="secondary">没有对不上号的件。</Typography.Text>
          ) : (
            <Table<HeldItem> rowKey={(record) => record.body.id} size="small" pagination={false} columns={heldColumns} dataSource={result.held} />
          )}
        </Card>
      </Col>
      <Col xs={24} xl={12}>
        <Card size="small" title={<Space><Tag color="gold">有单无胎</Tag><Badge count={result.unbound.length} color="#c9963c" /></Space>}>
          {result.unbound.length === 0 ? (
            <Typography.Text type="secondary">在制委托都已认到胎体。</Typography.Text>
          ) : (
            <Space direction="vertical" style={{ width: '100%' }}>
              {result.unbound.map((commission) => {
                const latest = latestRevision(commission);
                return (
                  <Card key={commission.id} size="small" styles={{ body: { padding: 10 } }}>
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                      <Space direction="vertical" size={0}>
                        <Space size={4}>
                          <Tag color="#8c2f1f">{commission.code}</Tag>
                          <span>{commission.clientName}</span>
                          {dueTag(commission)}
                        </Space>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {latest ? `${BODY_SHAPE_LABEL[latest.shape]} · ${latest.sizeMm}mm` : ''} · 交期 {commission.dueDate || '未定'}
                        </Typography.Text>
                      </Space>
                      <Button size="small" onClick={() => openBind(commission.id)}>认单到胎体</Button>
                    </Space>
                  </Card>
                );
              })}
            </Space>
          )}
        </Card>
      </Col>
      <Col xs={24} xl={12}>
        <Card size="small" title={<Space><Tag>无单单列</Tag><Badge count={result.unlinked.length} color="#8c8479" /></Space>}>
          {result.unlinked.length === 0 ? (
            <Typography.Text type="secondary">没有缺单号的胎体。</Typography.Text>
          ) : (
            <Table rowKey="id" size="small" pagination={false} columns={unlinkedColumns} dataSource={result.unlinked} />
          )}
        </Card>
      </Col>
      <Col span={24}>
        <Card size="small" title={<Space><Tag color="blue">撤单留存</Tag><Badge count={retainedBodies.length} color="#3a6ea5" /></Space>}>
          {retainedBodies.length === 0 ? (
            <Typography.Text type="secondary">没有撤单后留存的已髹涂件。</Typography.Text>
          ) : (
            <Space wrap>
              {retainedBodies.map((body) => {
                const commission = commissions.find((item) => item.id === body.commissionId);
                const bodyCoats = coats.filter((coat) => coat.bodyId === body.id);
                return (
                  <Card key={body.id} size="small" styles={{ body: { padding: 10 } }} style={{ minWidth: 260 }}>
                    <Space direction="vertical" size={2}>
                      <Space size={4}>
                        <Tag color="#8c2f1f">{body.code}</Tag>
                        <Tag color="default">{commission?.code ?? '委托已删'}</Tag>
                      </Space>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        已涂 {bodyCoats.filter((coat) => coat.state !== 'todo').length} 道留存，未涂 {bodyCoats.filter((coat) => coat.returned).length} 道退回
                      </Typography.Text>
                      <Button
                        size="small"
                        type="link"
                        onClick={() => {
                          setCurrentBodyId(body.id);
                          navigate(ROUTES.coats);
                        }}
                      >
                        看道次
                      </Button>
                    </Space>
                  </Card>
                );
              })}
            </Space>
          )}
        </Card>
      </Col>
    </Row>
  );

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>接单前台 · 委托单</h2>
          <p>前台留委托单（委托人、器型、尺寸、交期），工序台管胎体与髹涂道次；每件胎体认一张单，两边按编号对账。</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          登记委托单
        </Button>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="委托单总数" value={commissions.length} suffix="张" tone="primary" />
        <StatBadge label="在制" value={activeCount} suffix="张" tone="success" />
        <StatBadge label="有单无胎" value={result.unbound.length} suffix="张" tone="warning" />
        <StatBadge label="挂起待判" value={result.held.length} suffix="件" tone="danger" />
        <StatBadge label="无单单列" value={result.unlinked.length} suffix="件" tone="info" />
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'orders', label: '委托单台账', children: ordersTab },
          {
            key: 'reconcile',
            label: (
              <span>
                对账
                {result.held.length > 0 ? <Badge count={result.held.length} color="#b03a2e" size="small" offset={[6, -2]} /> : null}
              </span>
            ),
            children: reconcileTab,
          },
        ]}
      />

      {/* 登记 / 编辑委托单 */}
      <Modal
        open={open}
        title={editing ? `编辑委托单 ${editing.code}` : '登记委托单'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="code" label="委托单号" rules={[{ required: true, message: '请输入单号，如 WT-2606' }]} style={{ flex: 1 }}>
              <Input placeholder="WT-2606" disabled={!!editing} />
            </Form.Item>
            <Form.Item name="dueDate" label="交期" rules={[{ required: true, message: '请选择交期' }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="clientName" label="委托人" rules={[{ required: true, message: '请填写委托人' }]} style={{ flex: 1 }}>
              <Input placeholder="如：陈氏委托" />
            </Form.Item>
            <Form.Item name="contact" label="联系方式" style={{ flex: 1 }}>
              <Input placeholder="选填" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="shape" label="器型" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...BODY_SHAPE_OPTIONS]} disabled={!!editing} />
            </Form.Item>
            <Form.Item name="sizeMm" label="尺寸（mm）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={10} max={2000} style={{ width: '100%' }} disabled={!!editing} />
            </Form.Item>
            <Form.Item name="material" label="胎体材质" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...BODY_MATERIAL_OPTIONS]} />
            </Form.Item>
          </Space>
          {editing ? (
            <Alert
              type="warning"
              showIcon
              message="器型 / 尺寸在此不可直接改"
              description="委托人中途改了器型或尺寸，请关闭本框后点「改尺寸器型」登记新版本，系统会把湿膜厚度建议与荫干时长作废重算。"
            />
          ) : (
            <Form.Item name="revisionNote" label="备注">
              <Input placeholder="选填" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 改尺寸器型：新版本 + 已开工件处置口径 */}
      <Modal
        open={!!revising}
        title={revising ? `改尺寸器型：${revising.code}（出第 ${revising.revisions.length + 1} 版）` : ''}
        onCancel={() => setRevising(null)}
        onOk={() => void submitRevise()}
        okText="登记新版本"
        cancelText="取消"
        destroyOnClose
      >
        {revising ? (
          <Form form={reviseForm} layout="vertical" preserve={false} initialValues={{ shape: latestRevision(revising)?.shape }}>
            <Timeline
              items={revising.revisions.map((revision) => ({
                children: (
                  <span>
                    第 {revision.revisionNo} 版：{BODY_SHAPE_LABEL[revision.shape]} · {revision.sizeMm}mm
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {' '}— {revision.note}
                    </Typography.Text>
                  </span>
                ),
              }))}
            />
            <Space size={12} style={{ display: 'flex' }}>
              <Form.Item name="shape" label="新器型" rules={[{ required: true }]} style={{ flex: 1 }}>
                <Select options={[...BODY_SHAPE_OPTIONS]} />
              </Form.Item>
              <Form.Item name="sizeMm" label="新尺寸（mm）" rules={[{ required: true }]} style={{ flex: 1 }}>
                <InputNumber min={10} max={2000} style={{ width: '100%' }} />
              </Form.Item>
            </Space>
            <Form.Item name="note" label="改版说明">
              <Input placeholder="如：委托人要求口径收小" />
            </Form.Item>
            <Form.Item
              name="policy"
              label="已开工件怎么办"
              rules={[{ required: true, message: '请选一种处置口径' }]}
              extra="未开工件无需选择，一律按新版重算湿膜厚度与荫干时长建议。"
            >
              <Radio.Group>
                <Space direction="vertical">
                  {CHANGE_POLICY_OPTIONS.map((option) => (
                    <Radio key={option.value} value={option.value}>
                      {CHANGE_POLICY_LABEL[option.value as ChangePolicy]}
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </Form.Item>
          </Form>
        ) : null}
      </Modal>

      {/* 撤单 */}
      <Modal
        open={!!cancelling}
        title={cancelling ? `撤单：${cancelling.code}` : ''}
        onCancel={() => setCancelling(null)}
        onOk={() => void submitCancel()}
        okText="确认撤单"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="撤单后：没开工的胎体退回排产；已髹涂的件留着（未涂道次退回，已涂道次留存）。"
        />
        <Input.TextArea
          rows={3}
          placeholder="撤单原因（选填）"
          value={cancelNote}
          onChange={(event) => setCancelNote(event.target.value)}
        />
      </Modal>

      {/* 认单：有单无胎 → 选胎体；无单胎体 → 选委托单 */}
      <Modal
        open={bindingBody !== null}
        title={bindCommissionId ? '把委托单认到胎体' : '胎体认一张委托单'}
        onCancel={() => {
          setBindingBody(null);
          setBindCommissionId(undefined);
        }}
        onOk={() => {
          if (bindCommissionId && bindingBody) void submitBind();
          else message.warning('请选齐胎体与委托单');
        }}
        okText="认单"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Typography.Text type="secondary">胎体</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              placeholder="选择要认单的胎体"
              value={bindingBody || undefined}
              disabled={
                !!bindCommissionId &&
                !!(bindingBody && bodyRecordById.get(bindingBody)?.commissionId &&
                  !result.unlinked.some((item) => item.id === bindingBody))
              }
              options={bindableBodies.map((body) => ({
                value: body.id,
                label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]} · ${body.sizeMm}mm${body.commissionId ? `（现认 ${commissions.find((c) => c.id === body.commissionId)?.code ?? '缺单'}）` : ''}`,
              }))}
              onChange={(value: string) => setBindingBody(value)}
            />
          </div>
          <div>
            <Typography.Text type="secondary">委托单</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              placeholder="选择委托单"
              value={bindCommissionId}
              disabled={!!bindCommissionId}
              options={bindableCommissions.map((commission) => {
                const latest = latestRevision(commission);
                return {
                  value: commission.id,
                  label: `${commission.code} · ${commission.clientName} · ${latest ? `${BODY_SHAPE_LABEL[latest.shape]}/${latest.sizeMm}mm` : ''}`,
                };
              })}
              onChange={(value: string) => setBindCommissionId(value)}
            />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            每件胎体只能认一张委托单；认单后按编号自动对账，对不上会进挂起。
          </Typography.Text>
        </Space>
      </Modal>

      {/* 判单 */}
      <Modal
        open={!!resolving}
        title={resolving ? `人工判定：胎体 ${resolving.body.code}` : ''}
        onCancel={() => setResolving(null)}
        onOk={async () => {
          if (!resolving) return;
          if (resolveChoice === 'unlink') {
            await unbindBody(resolving.body.id, resolving.detail);
            message.success('已判为无单胎体，移入无单单列');
          } else {
            const commissionId = resolving.commission?.id ?? bindCommissionId;
            if (!commissionId) {
              message.warning('该胎体查无原单，请选择一张委托单重新认单');
              return;
            }
            await resolveHeld(resolving.body.id, {
              commissionId,
              specRevision: resolving.commission?.revisions.length ?? 1,
              note: '人工判定维持认单',
            });
            await recomputeReconcile();
            message.success('已按判定重新对账');
          }
          setResolving(null);
        }}
        okText="提交判定"
        cancelText="取消"
        destroyOnClose
      >
        {resolving ? (
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <Alert type="error" showIcon message={`${HELD_REASON_LABEL[resolving.reason]}：${resolving.detail}`} />
            <Radio.Group value={resolveChoice} onChange={(event) => setResolveChoice(event.target.value)}>
              <Space direction="vertical">
                <Radio value="relink" disabled={!resolving.commission}>
                  维持认单（{resolving.commission ? `${resolving.commission.code}，按最新第 ${resolving.commission.revisions.length} 版核对` : '原单号查无委托单，无法维持'}）
                </Radio>
                <Radio value="unlink">判为无单胎体（解绑，进无单单列）</Radio>
              </Space>
            </Radio.Group>
            {resolveChoice === 'relink' && resolving.commission ? (
              <Alert
                type="info"
                showIcon
                message={`选择「照旧做完」可到道次页查看依据版本；若委托人已改版，可重新执行「改尺寸器型 → 退回重排」。`}
              />
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
