/**
 * /orders 委托单与对账（接单前台）
 * 前台留委托单（委托人、器型、尺寸、交期），按编号与工序台胎体对账；
 * 对不上号先挂起等人判，缺号按委托人回填，撤单区分未开工退回与已髹涂留着。
 * 消费 Order、Body、Coat；复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { useMemo, useState } from 'react';
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
  CloudSyncOutlined,
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useOrderStore } from '@/stores/orderStore';
import { BODY_SHAPE_LABEL, BODY_SHAPE_OPTIONS, type BodyShape } from '@/types/body';
import {
  ORDER_STATUS_COLOR,
  ORDER_STATUS_LABEL,
  createEmptyOrderDraft,
  type Order,
  type OrderDraft,
  type OrderStatus,
} from '@/types/order';
import {
  RECONCILE_STATUS_COLOR,
  RECONCILE_STATUS_LABEL,
  reconcileBodies,
  type ReconcileView,
} from '@/utils/reconcile';

export default function OrderBoard() {
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<OrderDraft>();
  const [specForm] = Form.useForm<{ shape: BodyShape; sizeMm: number; changeNote: string }>();
  const [linkForm] = Form.useForm<{ orderId: string }>();

  const bodies = useBodyStore((state) => state.bodies);
  const orders = useOrderStore((state) => state.orders);
  const createOrder = useOrderStore((state) => state.createOrder);
  const updateOrder = useOrderStore((state) => state.updateOrder);
  const changeSpec = useOrderStore((state) => state.changeSpec);
  const cancelOrder = useOrderStore((state) => state.cancelOrder);
  const completeOrder = useOrderStore((state) => state.completeOrder);
  const removeOrder = useOrderStore((state) => state.removeOrder);
  const linkBody = useOrderStore((state) => state.linkBody);
  const unlinkBody = useOrderStore((state) => state.unlinkBody);
  const runReconcile = useOrderStore((state) => state.runReconcile);
  const runBackfill = useOrderStore((state) => state.runBackfill);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Order | null>(null);
  const [specOpen, setSpecOpen] = useState(false);
  const [specOrder, setSpecOrder] = useState<Order | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkBodyId, setLinkBodyId] = useState<string | null>(null);

  const views = useMemo(() => reconcileBodies(bodies, orders), [bodies, orders]);
  const suspended = views.filter((view) => view.status === 'suspended');
  const unlinked = views.filter((view) => view.status === 'unlinked');
  const returned = views.filter((view) => view.status === 'returned');

  const progressOfOrder = (orderId: string): { total: number; done: number } => {
    const linkedBodies = bodies.filter((body) => body.orderId === orderId);
    const total = linkedBodies.length;
    const done = linkedBodies.filter((body) => body.state === 'done').length;
    return { total, done };
  };

  const stat = useMemo(() => {
    const active = orders.filter((order) => order.status === 'active').length;
    const cancelled = orders.filter((order) => order.status === 'cancelled').length;
    const done = orders.filter((order) => order.status === 'done').length;
    return { total: orders.length, active, cancelled, done };
  }, [orders]);

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue(createEmptyOrderDraft());
    setOpen(true);
  };

  const openEdit = (order: Order): void => {
    setEditing(order);
    form.setFieldsValue({
      orderNo: order.orderNo,
      ownerName: order.ownerName,
      shape: order.shape,
      sizeMm: order.sizeMm,
      dueDate: order.dueDate,
      note: order.note,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (editing) {
      await updateOrder(editing.id, values);
      message.success(`已更新委托单 ${values.orderNo}`);
    } else {
      const created = await createOrder(values);
      message.success(`已建委托单 ${created.orderNo}，可在胎体台账关联`);
    }
    setOpen(false);
  };

  const openSpec = (order: Order): void => {
    setSpecOrder(order);
    specForm.setFieldsValue({ shape: order.shape, sizeMm: order.sizeMm, changeNote: '' });
    setSpecOpen(true);
  };

  const submitSpec = async (): Promise<void> => {
    if (!specOrder) return;
    const values = await specForm.validateFields();
    const result = await changeSpec(specOrder.id, values.shape, values.sizeMm, values.changeNote);
    setSpecOpen(false);
    const parts: string[] = [];
    if (result.rescheduled.length > 0) parts.push(`退回重排 ${result.rescheduled.length} 件（${result.rescheduled.join('、')}）`);
    if (result.finishAsIs.length > 0) parts.push(`已开工照旧做完 ${result.finishAsIs.length} 件（${result.finishAsIs.join('、')}）`);
    message.success(`规格已更新至 v${specOrder.version + 1}：${parts.join('；')}`);
  };

  const handleCancel = (order: Order): void => {
    modal.confirm({
      title: `撤掉委托单 ${order.orderNo}`,
      content: '未开工的胎体将退回，已髹涂的胎体留着继续做完。',
      okText: '确认撤单',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        const result = await cancelOrder(order.id);
        const parts: string[] = [];
        if (result.returned.length > 0) parts.push(`退回 ${result.returned.length} 件`);
        if (result.kept.length > 0) parts.push(`留着 ${result.kept.length} 件`);
        message.success(`已撤单：${parts.join('，') || '无关联胎体'}`);
      },
    });
  };

  const openLink = (bodyId: string): void => {
    setLinkBodyId(bodyId);
    linkForm.setFieldsValue({ orderId: undefined });
    setLinkOpen(true);
  };

  const submitLink = async (): Promise<void> => {
    if (!linkBodyId) return;
    const values = await linkForm.validateFields();
    await linkBody(linkBodyId, values.orderId);
    message.success('已关联委托单并清除挂起');
    setLinkOpen(false);
  };

  const handleBackfill = async (): Promise<void> => {
    const result = await runBackfill();
    if (result.linked.length === 0 && result.unmatched.length === 0) {
      message.info('没有待回填的胎体');
      return;
    }
    const parts: string[] = [];
    if (result.linked.length > 0) parts.push(`按委托人回填 ${result.linked.length} 件（${result.linked.join('、')}）`);
    if (result.unmatched.length > 0) parts.push(`填不出单列 ${result.unmatched.length} 件（${result.unmatched.join('、')}），需人工补单`);
    if (result.linked.length > 0) message.success(parts.join('；'));
    else message.warning(parts.join('；'));
  };

  const orderColumns: ColumnsType<Order> = [
    {
      title: '委托单号',
      dataIndex: 'orderNo',
      width: 130,
      render: (value: string, record) => (
        <Space size={6} wrap>
          <Tag color="#8c2f1f">{value}</Tag>
          <Tag>v{record.version}</Tag>
        </Space>
      ),
    },
    { title: '委托人', dataIndex: 'ownerName', width: 140 },
    {
      title: '器型 / 尺寸',
      key: 'spec',
      width: 140,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Tag>{BODY_SHAPE_LABEL[record.shape]}</Tag>
          <Tag color="gold">{record.sizeMm} mm</Tag>
        </Space>
      ),
    },
    { title: '交期', dataIndex: 'dueDate', width: 120, sorter: (a, b) => a.dueDate.localeCompare(b.dueDate) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: OrderStatus) => <Tag color={ORDER_STATUS_COLOR[value]}>{ORDER_STATUS_LABEL[value]}</Tag>,
    },
    {
      title: '关联进度',
      key: 'progress',
      width: 130,
      render: (_value, record) => {
        const { total, done } = progressOfOrder(record.id);
        return total === 0 ? (
          <Typography.Text type="secondary">无关联胎体</Typography.Text>
        ) : (
          <Typography.Text>
            {done} / {total} 件完成
          </Typography.Text>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 280,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Tooltip title="委托人改尺寸器型：未开工件退回重排，已开工件照旧做完">
            <Button size="small" type="link" icon={<SwapOutlined />} onClick={() => openSpec(record)}>
              改规格
            </Button>
          </Tooltip>
          {record.status === 'active' ? (
            <Button size="small" type="link" onClick={() => void completeOrder(record.id)}>
              完成
            </Button>
          ) : null}
          {record.status === 'active' ? (
            <Popconfirm
              title="撤掉该委托单"
              description="未开工胎体退回，已髹涂留着。"
              okText="确认撤单"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleCancel(record)}
            >
              <Button size="small" type="link" danger>
                撤单
              </Button>
            </Popconfirm>
          ) : null}
          <Popconfirm
            title="删除该委托单"
            description="关联胎体会解除关联并列入待回填，不可恢复。"
            okText="确认删除"
            cancelText="取消"
            onConfirm={() => void removeOrder(record.id).then(() => message.success('已删除委托单'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const reconcileColumns: ColumnsType<ReconcileView> = [
    {
      title: '胎体编号',
      dataIndex: ['body', 'code'],
      width: 130,
      render: (_value, view) => <Tag color="#8c2f1f">{view.body.code}</Tag>,
    },
    { title: '委托人', dataIndex: ['body', 'ownerName'], width: 140 },
    {
      title: '器型 / 尺寸',
      key: 'spec',
      width: 140,
      render: (_value, view) => (
        <Space size={4} wrap>
          <Tag>{BODY_SHAPE_LABEL[view.body.shape]}</Tag>
          <Tag color="gold">{view.body.sizeMm} mm</Tag>
        </Space>
      ),
    },
    {
      title: '对账状态',
      dataIndex: 'status',
      width: 110,
      render: (value: ReconcileView['status']) => (
        <Tag color={RECONCILE_STATUS_COLOR[value]}>{RECONCILE_STATUS_LABEL[value]}</Tag>
      ),
    },
    { title: '原因', dataIndex: 'reason', render: (value: string) => <Typography.Text type="secondary">{value}</Typography.Text> },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_value, view) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<LinkOutlined />} onClick={() => openLink(view.body.id)}>
            关联委托单
          </Button>
          {view.body.orderNo ? (
            <Button size="small" type="link" onClick={() => void unlinkBody(view.body.id)}>
              解除
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>委托单与对账</h2>
          <p>
            接单前台留委托单（委托人、器型、尺寸、交期），工序台按编号对账；对不上号先挂起等人判，缺号按委托人回填。
          </p>
        </div>
        <Space wrap>
          <Button icon={<CloudSyncOutlined />} onClick={() => void runReconcile().then(() => message.success('已按编号对账'))}>
            重新对账
          </Button>
          <Button icon={<ReloadOutlined />} onClick={handleBackfill}>
            按委托人回填
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建委托单
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="委托单总数" value={stat.total} suffix="张" tone="primary" />
        <StatBadge label="进行中" value={stat.active} suffix="张" tone="info" />
        <StatBadge label="已完成" value={stat.done} suffix="张" tone="success" />
        <StatBadge label="已撤单" value={stat.cancelled} suffix="张" />
        <StatBadge label="挂起胎体" value={suspended.length} suffix="件" tone="danger" />
        <StatBadge label="待回填" value={unlinked.length} suffix="件" tone="warning" />
      </div>

      {suspended.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`${suspended.length} 件胎体对账对不上号，已挂起等待人工判定`}
          description="请在下方「对账与回填」中关联正确的委托单，或解除挂起。"
        />
      ) : null}

      <Card className="gb-table-card" title="委托单台账" styles={{ body: { padding: 0 } }}>
        {orders.length === 0 ? (
          <EmptyPanel
            title="还没有委托单"
            description="接单前台新建委托单，记录委托人、器型、尺寸与交期；工序台胎体凭委托单号对账。"
            actionText="新建委托单"
            onAction={openCreate}
            size="small"
          />
        ) : (
          <Table<Order>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 8 }}
            columns={orderColumns}
            dataSource={orders}
          />
        )}
      </Card>

      <Card className="gb-table-card" title="对账与回填" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {views.length === 0 ? (
          <EmptyPanel title="还没有胎体" description="先在胎体台账登记胎体，再按委托单号对账。" size="small" />
        ) : (
          <Table<ReconcileView>
            rowKey={(view) => view.body.id}
            size="small"
            pagination={false}
            columns={reconcileColumns}
            dataSource={views}
            rowClassName={(view) => (view.status === 'suspended' ? 'gb-row-suspended' : '')}
          />
        )}
      </Card>

      {returned.length > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 14 }}
          message={`${returned.length} 件胎体因委托撤单未开工已退回`}
          description={returned.map((view) => view.body.code).join('、')}
        />
      ) : null}

      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
        道次页可查看每件胎体依据的委托单版本；已开工件按旧版照旧做完，未开工件退回重排并按新版重算湿膜厚度与荫干时长。
      </Typography.Text>

      {/* 新建 / 编辑委托单 */}
      <Modal
        open={open}
        title={editing ? `编辑委托单 ${editing.orderNo}` : '新建委托单'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="orderNo" label="委托单号" rules={[{ required: true, message: '如 WT-2405' }]} style={{ flex: 1 }}>
              <Input placeholder="WT-2405" />
            </Form.Item>
            <Form.Item name="ownerName" label="委托人" rules={[{ required: true, message: '请填写委托人' }]} style={{ flex: 1 }}>
              <Input placeholder="如：陈氏委托" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="shape" label="器型" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...BODY_SHAPE_OPTIONS]} />
            </Form.Item>
            <Form.Item name="sizeMm" label="尺寸（mm）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={10} max={2000} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="dueDate" label="交期" rules={[{ required: true }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="工艺要求、委托人特殊交代等" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 改规格 */}
      <Modal
        open={specOpen}
        title={specOrder ? `委托单 ${specOrder.orderNo} 改规格（当前 v${specOrder.version}）` : '改规格'}
        onCancel={() => setSpecOpen(false)}
        onOk={() => void submitSpec()}
        okText="确认改规格"
        cancelText="取消"
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="未开工件退回重排，湿膜厚度与荫干时长按新版作废重算；已髹涂件照旧做完并保留旧版依据。"
        />
        <Form form={specForm} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="shape" label="器型" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...BODY_SHAPE_OPTIONS]} />
            </Form.Item>
            <Form.Item name="sizeMm" label="尺寸（mm）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={10} max={2000} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="changeNote" label="变更说明" rules={[{ required: true, message: '请填写变更说明' }]}>
            <Input placeholder="如：委托人改器型为瓶，尺寸加大" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 关联委托单 */}
      <Modal
        open={linkOpen}
        title="关联委托单"
        onCancel={() => setLinkOpen(false)}
        onOk={() => void submitLink()}
        okText="关联并清除挂起"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={linkForm} layout="vertical" preserve={false}>
          <Form.Item name="orderId" label="委托单" rules={[{ required: true, message: '请选择委托单' }]}>
            <Select
              showSearch
              placeholder="选择委托单"
              optionFilterProp="label"
              options={orders
                .filter((order) => order.status !== 'cancelled')
                .map((order) => ({
                  value: order.id,
                  label: `${order.orderNo} · ${order.ownerName} · ${BODY_SHAPE_LABEL[order.shape]}`,
                }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
